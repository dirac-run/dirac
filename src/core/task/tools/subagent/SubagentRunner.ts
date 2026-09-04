import * as path from "node:path"
import { formatResponse } from "@core/formatResponse"
import { StreamResponseHandler } from "@core/task/StreamResponseHandler"
import { type ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import { SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { DiracContent, DiracStorageMessage, DiracTextContentBlock } from "@shared/messages"
import { Logger } from "@shared/services/Logger"
import { NATIVE_WEB_SEARCH_SKILL_NAME } from "@shared/skills"
import { SubagentTrajectoryEventType } from "@shared/subagents"
import { DiracTool } from "@shared/tools"
import { ContextManager } from "@/core/context/context-management/ContextManager"
import { checkContextWindowExceededError } from "@/core/context/context-management/context-error-handling"
import { DiracError, DiracErrorType } from "@/services/error"
import { calculateApiCostAnthropic } from "@/utils/cost"
import { TaskState } from "../../TaskState"
import { excerpt } from "../../utils/excerpt"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { SubagentRuntime, TaskConfig } from "../types/TaskConfig"
import { SubagentAbortHandler } from "./SubagentAbortHandler"
import { SubagentBuilder, type SubagentBuilderOptions } from "./SubagentBuilder"
import { SubagentContextBuilder } from "./SubagentContextBuilder"
import { resolveSubagentTimeoutSeconds } from "./SubagentExecutionPolicy"
import {
	createEmptyRequestUsageState,
	createEmptySubagentRunStats,
	getBestEffortResult,
	normalizeToolCallArguments,
	parseNonNativeToolCalls,
	resolveToolUseId,
	toAssistantToolUseBlock,
} from "./SubagentRunHelpers"
import { SubagentRunProgress } from "./SubagentRunProgress"
import type { SubagentDiagnosticEvent, SubagentRunPhase, SubagentTranscriptEvent } from "./SubagentRunRecorder"
import { SubagentRunState } from "./SubagentRunState"
import type {
	SubagentProgressUpdate,
	SubagentRunResult,
	SubagentRunStats,
	SubagentRunStatus,
	SubagentToolCall,
	SubagentUsageState,
} from "./SubagentRunTypes"
import { SubagentToolExecutor } from "./SubagentToolExecutor"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_EMPTY_ASSISTANT_RETRIES = 3
const MAX_INITIAL_STREAM_ATTEMPTS = 3
const INITIAL_STREAM_RETRY_BASE_DELAY_MS = 2_000
const PARENT_ABORT_POLL_INTERVAL_MS = 50
const WRAP_UP_TIMEOUT_SECONDS = 90
const WRAP_UP_PROMPT =
	'The research deadline has elapsed. Stop investigating and summarize the concrete findings you already established. Call respond with operation "complete" now. Do not perform further research.'

interface SubagentContextState {
	conversationHistoryDeletedRange?: [number, number]
}

export class SubagentRunner {
	private readonly agent: SubagentBuilder
	private readonly runtime: SubagentRuntime
	private readonly allowedTools: string[]
	private readonly contextBuilder: SubagentContextBuilder
	private readonly abortHandler: SubagentAbortHandler
	private readonly toolExecutor: SubagentToolExecutor
	private activeApiAbort: (() => void) | undefined
	private abortRequested = false
	private abortReason?: string
	private abortingCommands = false
	private activeTaskState?: TaskState
	private activeConversation: DiracStorageMessage[] = []
	private activeStats = createEmptySubagentRunStats()
	private readonly subagentName: string
	private wrapUpRequested = false
	private isWrappingUp = false

	constructor(
		private baseConfig: TaskConfig,
		subagentName = "subagent",
		private readonly options: SubagentBuilderOptions = {},
	) {
		this.agent = new SubagentBuilder(baseConfig, subagentName, options)
		this.subagentName = subagentName
		this.runtime = this.agent.getRuntime()
		this.allowedTools = this.agent.getAllowedTools()
		this.contextBuilder = new SubagentContextBuilder(baseConfig, this.agent, this.allowedTools, this.runtime)
		const logPrefix = `[SubagentRunner:${this.subagentName || "unnamed"}]`
		this.runProgress = new SubagentRunProgress(options.recorder, logPrefix)
		this.runState = new SubagentRunState(baseConfig, this.runProgress)
		this.abortHandler = new SubagentAbortHandler(() => this.abortReason, getBestEffortResult)
		this.toolExecutor = new SubagentToolExecutor(
			(state, coordinator) => this.createSubagentTaskConfig(state, coordinator),
			(name, snap) => this.isAllowedTool(name, snap),
			{
				recordToolCall: (call) =>
					this.runProgress.recordTranscript("tool_call", {
						toolUseId: call.toolUseId,
						id: call.id,
						callId: call.call_id,
						name: call.name,
						input: call.input,
						isNativeToolCall: call.isNativeToolCall,
					}),
				recordToolResult: (call, result) =>
					this.runProgress.recordTranscript("tool_result", {
						toolUseId: call.toolUseId,
						id: call.id,
						callId: call.call_id,
						name: call.name,
						result,
					}),
				recordProgress: (text) => this.runProgress.recordTranscript("progress", { text }),
				markActivity: (action) => this.runState.markActivity(action),
			},
		)
	}

	private getRuntimeProgress(): Pick<
		SubagentProgressUpdate,
		"phase" | "phaseStartedAt" | "lastActivityAt" | "isStalled" | "transcriptPath" | "diagnosticsPath"
	> {
		return this.runState.getRuntimeProgress()
	}

	private getDiagnosticDetails(details: Record<string, unknown> = {}): Record<string, unknown> {
		return this.runState.getDiagnosticDetails(details)
	}

	private enterPhase(phase: SubagentRunPhase, action: string, details: Record<string, unknown> = {}): void {
		this.runState.enterPhase(phase, action, details)
	}

	private markActivity(action: string): void {
		this.runState.markActivity(action)
	}

	private startHeartbeat(): void {
		this.runState.startHeartbeat()
	}

	private recordTranscript(type: SubagentTranscriptEvent["type"], details: Record<string, unknown>): void {
		this.runProgress.recordTranscript(type, details)
	}

	private recordDiagnostic(
		type: SubagentDiagnosticEvent["type"],
		phase: SubagentRunPhase,
		details: Record<string, unknown> = {},
	): void {
		this.runProgress.recordDiagnostic(type, phase, this.runState.getDiagnosticDetails(details))
	}

	private recordTerminal(result: SubagentRunResult): void {
		// Phase transition must happen before the terminal record so progress
		// reports a final "cancelled" (not "cancelling") on timeout/abort.
		this.enterPhase(this.phaseForStatus(result.status), "subagent run settled", { status: result.status })
		this.runProgress.recordTerminal(
			result,
			this.runState.getDiagnosticDetails({
				result: result.result,
				error: result.error,
				stats: result.stats,
				abortReason: this.abortReason,
			}),
		)
	}

	private isAllowedTool(toolName: string, requestSnapshot: ToolRequestSnapshot): boolean {
		return requestSnapshot.coordinator.has(toolName)
	}

	async abort(reason?: string): Promise<void> {
		this.abortRequested = true
		if (reason) {
			this.abortReason = reason
		}
		if (!this.abortReason && this.baseConfig.taskState.abort) {
			this.abortReason = "Subagent run cancelled because the parent task was cancelled."
		}
		this.enterPhase("cancelling", "abort requested", { reason: this.abortReason })
		this.recordDiagnostic("abort_requested", "cancelling", { reason: this.abortReason })
		if (this.activeTaskState) {
			this.activeTaskState.abort = true
		}
		await this.stopActiveWork()
	}

	private async requestWrapUp(): Promise<void> {
		if (this.wrapUpRequested || this.isWrappingUp || this.shouldAbort()) return
		this.wrapUpRequested = true
		this.enterPhase("wrapping_up", "execution deadline reached")
		this.recordTranscript("progress", { text: "Time limit reached. Wrapping up findings." })
		this.recordDiagnostic("abort_requested", "wrapping_up", { reason: "execution deadline reached" })
		this.runProgress.enqueueExecutionProgress({
			...this.getRuntimeProgress(),
			isWrappingUp: true,
			trajectoryEvent: { type: SubagentTrajectoryEventType.MESSAGE, text: "Time limit reached. Wrapping up findings." },
			stats: { ...this.activeStats },
		})
		await this.stopActiveWork()
	}

	private beginWrapUp(conversation: DiracStorageMessage[]): boolean {
		if (!this.wrapUpRequested || this.isWrappingUp) return false
		this.isWrappingUp = true
		this.markActivity("sent wrap-up prompt")
		conversation.push({
			role: "user",
			content: [{ type: "text", text: WRAP_UP_PROMPT } as DiracTextContentBlock],
		})
		return true
	}

	private async stopActiveWork(): Promise<void> {
		try {
			this.activeApiAbort?.()
		} catch (error) {
			Logger.error("[SubagentRunner] failed to abort active API stream", error)
		}

		if (
			this.runState.activeCommandExecutions > 0 &&
			!this.abortingCommands &&
			this.baseConfig.callbacks.cancelRunningCommandTool
		) {
			this.abortingCommands = true
			try {
				await this.baseConfig.callbacks.cancelRunningCommandTool()
			} catch (error) {
				Logger.error("[SubagentRunner] failed to cancel running command execution", error)
			} finally {
				this.abortingCommands = false
			}
		}
	}

	private phaseForStatus(status: SubagentRunStatus): SubagentRunPhase {
		return this.runState.phaseForStatus(status)
	}

	private shouldAbort(): boolean {
		return this.abortRequested || this.baseConfig.taskState.abort
	}

	private async getWorkspaceMetadataEnvironmentBlock(): Promise<string | null> {
		try {
			const workspacesJson =
				(await this.baseConfig.workspaceManager?.buildWorkspacesJson()) ??
				JSON.stringify(
					{
						workspaces: {
							[this.baseConfig.cwd]: {
								hint: path.basename(this.baseConfig.cwd) || this.baseConfig.cwd,
							},
						},
					},
					null,
					2,
				)

			return `<environment_details>\n# Workspace Configuration\n${workspacesJson}\n</environment_details>`
		} catch (error) {
			Logger.warn("[SubagentRunner] Failed to build workspace metadata block", error)
			return null
		}
	}

	async run(
		prompt: string,
		onProgress: (update: SubagentProgressUpdate) => void | Promise<void>,
		timeout?: number,
		includeHistory?: boolean,
	): Promise<SubagentRunResult> {
		const timeoutSeconds = resolveSubagentTimeoutSeconds(timeout)
		const logPrefix = `[SubagentRunner:${this.subagentName || "unnamed"}]`
		this.abortRequested = false
		this.abortReason = undefined
		this.wrapUpRequested = false
		this.isWrappingUp = false
		this.activeTaskState = undefined
		this.activeConversation = []
		this.activeStats = createEmptySubagentRunStats()
		this.runState.reset()
		this.runProgress.beginExecution(onProgress)
		this.enterPhase("starting", "subagent run dispatched", { timeoutSeconds, includeHistory: includeHistory === true })
		this.recordTranscript("progress", {
			message: "subagent run dispatched",
			timeoutSeconds,
			includeHistory: includeHistory === true,
		})
		this.startHeartbeat()

		let resolveTermination!: () => void
		const terminationPromise = new Promise<void>((resolve) => {
			resolveTermination = resolve
		})
		let terminationRequested = false
		const requestTermination = (reason: string) => {
			if (terminationRequested) return
			terminationRequested = true
			void this.abort(reason)
			resolveTermination()
		}
		let wrapUpTimeoutHandle: NodeJS.Timeout | undefined
		const scheduleWrapUp = () => {
			if (terminationRequested || this.wrapUpRequested || this.isWrappingUp) return
			void this.requestWrapUp()
			wrapUpTimeoutHandle = setTimeout(
				() =>
					requestTermination(
						`Subagent timed out after ${timeoutSeconds} seconds and could not finish wrapping up within ${WRAP_UP_TIMEOUT_SECONDS} seconds.`,
					),
				WRAP_UP_TIMEOUT_SECONDS * 1000,
			)
		}

		const timeoutHandle = setTimeout(scheduleWrapUp, timeoutSeconds * 1000)
		const parentAbortPoll = setInterval(() => {
			if (this.baseConfig.taskState.abort) {
				requestTermination("Subagent run cancelled because the parent task was cancelled.")
			}
		}, PARENT_ABORT_POLL_INTERVAL_MS)

		const executionPromise = this.executeRun(prompt, timeoutSeconds, includeHistory)
		void executionPromise.catch((error) => {
			if (terminationRequested) Logger.error(`${logPrefix} abandoned execution failed after termination`, error)
		})

		if (this.baseConfig.taskState.abort) {
			requestTermination("Subagent run cancelled because the parent task was cancelled.")
		}

		try {
			const outcome = await Promise.race([
				executionPromise.then((result) => ({ kind: "execution" as const, result })),
				terminationPromise.then(() => ({ kind: "termination" as const })),
			])

			if (outcome.kind === "execution") {
				this.recordTerminal(outcome.result)
				this.runProgress.stopAcceptingUpdates()
				const progressDrained = await this.drainProgressUpdates(undefined, logPrefix)
				if (!progressDrained) this.runProgress.discardQueuedUpdates()
				return outcome.result
			}

			this.runProgress.discardQueuedUpdates()
			const result = this.abortHandler.buildAbortResult(this.activeConversation, this.activeStats)
			this.recordTerminal(result)
			this.runProgress.stopAcceptingUpdates()
			await this.drainProgressUpdates(undefined, logPrefix)
			const terminalProgress = Promise.resolve()
				.then(() => onProgress(this.toTerminalProgressUpdate(result)))
				.catch((error) => Logger.error(`${logPrefix} terminal progress observer failed`, error))
			await this.drainProgressUpdates(terminalProgress, logPrefix)
			return result
		} finally {
			clearTimeout(timeoutHandle)
			if (wrapUpTimeoutHandle) clearTimeout(wrapUpTimeoutHandle)
			clearInterval(parentAbortPoll)
			this.runState.stopHeartbeat()
			this.runProgress.endExecution()
			// Fire-and-forget: recorder flush must not block terminal completion (matches pre-split behavior).
			void this.runProgress.flush()
		}
	}

	private async executeRun(prompt: string, timeout: number, includeHistory?: boolean): Promise<SubagentRunResult> {
		const state = new TaskState()
		state.abort = this.abortRequested
		state.activeSkillIds = [...this.baseConfig.taskState.activeSkillIds]
		state.availableSkills = this.baseConfig.taskState.availableSkills
		this.activeTaskState = state
		let emptyAssistantResponseRetries = 0
		const conversation = this.activeConversation
		const contextState: SubagentContextState = {}
		const contextManager = new ContextManager()
		const usageState: SubagentUsageState = {
			currentRequest: createEmptyRequestUsageState(),
		}
		const stats = this.activeStats

		const logPrefix = `[SubagentRunner:${this.subagentName || "unnamed"}]`
		const instrumentedOnProgress = (update: SubagentProgressUpdate) => {
			if (
				update.status === SubagentExecutionStatus.COMPLETED ||
				update.status === SubagentExecutionStatus.FAILED ||
				update.status === SubagentExecutionStatus.CANCELLED
			) {
				this.enterPhase(this.phaseForStatus(update.status), `reported ${update.status} status`, { status: update.status })
				Logger.info(`${logPrefix} ${update.status}: ${(update.result || update.error || "").substring(0, 200)}`)
			}
			this.runProgress.enqueueExecutionProgress({ ...this.getRuntimeProgress(), ...update })
		}

		instrumentedOnProgress({
			status: SubagentExecutionStatus.RUNNING,
			stats,
		})

		try {
			const runtime = this.runtime
			this.activeApiAbort = () => runtime.abort()

			this.enterPhase("building_initial_context", "building initial tool and provider context")
			const initialContext = await this.contextBuilder.buildContext()
			this.markActivity("initial context built")
			const context = initialContext.context
			state.availableSkills = context.skills ?? []
			let requestSnapshot = initialContext.requestSnapshot
			let useNativeToolCalls = initialContext.useNativeToolCalls
			stats.contextWindow = context.providerInfo.model.info.contextWindow || 0
			let systemPrompt = this.contextBuilder.appendExecutionDeadline(initialContext.systemPrompt, timeout)
			this.enterPhase("building_workspace_metadata", "building workspace metadata")
			const workspaceMetadataEnvironmentBlock = await this.getWorkspaceMetadataEnvironmentBlock()
			this.markActivity("workspace metadata built")

			if (this.shouldAbort()) {
				await this.abort()
				return this.reportAbortResult(conversation, stats, instrumentedOnProgress)
			}

			if (includeHistory) {
				conversation.push(...this.baseConfig.messageState.getApiConversationHistory())
				contextState.conversationHistoryDeletedRange = this.baseConfig.taskState.conversationHistoryDeletedRange
			}

			conversation.push({
				role: "user",
				content: [
					{
						type: "text",
						text: prompt,
					} as DiracTextContentBlock,
					// Server-side task loop checks require workspace metadata to be present in the
					// initial user message of subagent runs.
					...(workspaceMetadataEnvironmentBlock
						? [
							{
								type: "text",
								text: workspaceMetadataEnvironmentBlock,
							} as DiracTextContentBlock,
						]
						: []),
				],
			})
			while (true) {
				if (this.beginWrapUp(conversation)) {
					usageState.lastRequest = undefined
				}
				if (this.shouldAbort()) {
					await this.abort()
					return this.reportAbortResult(conversation, stats, instrumentedOnProgress)
				}

				if (
					!this.isWrappingUp &&
					usageState.lastRequest &&
					this.shouldCompactBeforeNextRequest(usageState.lastRequest.totalTokens, runtime.model.info.contextWindow)
				) {
					const compactResult = this.compactConversationForContextWindow(
						contextManager,
						conversation,
						contextState.conversationHistoryDeletedRange,
					)
					contextState.conversationHistoryDeletedRange = compactResult.conversationHistoryDeletedRange
					if (compactResult.didCompact) {
						Logger.warn("[SubagentRunner] Proactively compacted context before next subagent request.")
					}
					// Prevent repeated compaction attempts off the same token sample.
					usageState.lastRequest = undefined
				}

				const streamHandler = new StreamResponseHandler()
				const { toolUseHandler, reasonsHandler } = streamHandler.getHandlers()
				usageState.currentRequest = createEmptyRequestUsageState()
				const requestUsage = usageState.currentRequest
				const costBeforeRequest = stats.totalCost

				let assistantText = ""
				let assistantTextSignature: string | undefined
				let requestId: string | undefined

				const stream = this.createMessageWithInitialChunkRetry(
					runtime,
					systemPrompt,
					conversation,
					requestSnapshot.nativeTools,
					context.providerInfo.providerId,
					context.providerInfo.model.id,
					contextManager,
					contextState,
				)

				try {
					for await (const chunk of stream) {
						this.markActivity(`received provider ${chunk.type} chunk`)
						switch (chunk.type) {
							case "usage":
								requestId = requestId ?? chunk.id
								stats.inputTokens += chunk.inputTokens || 0
								stats.outputTokens += chunk.outputTokens || 0
								stats.cacheWriteTokens += chunk.cacheWriteTokens || 0
								stats.cacheReadTokens += chunk.cacheReadTokens || 0
								requestUsage.inputTokens += chunk.inputTokens || 0
								requestUsage.outputTokens += chunk.outputTokens || 0
								requestUsage.cacheWriteTokens += chunk.cacheWriteTokens || 0
								requestUsage.cacheReadTokens += chunk.cacheReadTokens || 0
								requestUsage.totalTokens =
									requestUsage.inputTokens +
									requestUsage.outputTokens +
									requestUsage.cacheWriteTokens +
									requestUsage.cacheReadTokens
								requestUsage.totalCost = chunk.totalCost ?? requestUsage.totalCost
								// Account as usage arrives so aborts, stream failures, and wrap-up retain billed usage.
								stats.totalCost = costBeforeRequest + (requestUsage.totalCost ?? calculateApiCostAnthropic(
									context.providerInfo.model.info,
									requestUsage.inputTokens,
									requestUsage.outputTokens,
									requestUsage.cacheWriteTokens,
									requestUsage.cacheReadTokens,
								) ?? 0)
								stats.contextTokens = requestUsage.totalTokens
								stats.contextUsagePercentage =
									stats.contextWindow > 0 ? (stats.contextTokens / stats.contextWindow) * 100 : 0
								this.recordTranscript("usage", {
									requestId: chunk.id,
									inputTokens: chunk.inputTokens,
									outputTokens: chunk.outputTokens,
									cacheWriteTokens: chunk.cacheWriteTokens,
									cacheReadTokens: chunk.cacheReadTokens,
									totalCost: chunk.totalCost,
								})
								instrumentedOnProgress({ stats: { ...stats } })
								break
							case "text":
								requestId = requestId ?? chunk.id
								assistantText += chunk.text || ""
								assistantTextSignature = chunk.signature || assistantTextSignature
								if (chunk.text) {
									this.recordTranscript("assistant_text", {
										requestId: chunk.id,
										text: chunk.text,
										signature: chunk.signature,
									})
									instrumentedOnProgress({ textChunk: chunk.text })
								}
								break
							case "tool_calls":
								requestId = requestId ?? chunk.id
								toolUseHandler.processToolUseDelta(
									{
										id: chunk.tool_call.function?.id,
										type: "tool_use",
										name: chunk.tool_call.function?.name,
										input: normalizeToolCallArguments(chunk.tool_call.function?.arguments),
										signature: chunk.signature,
									},
									chunk.tool_call.call_id,
								)
								break
							case "reasoning":
								requestId = requestId ?? chunk.id
								break
						}

						if (this.shouldAbort()) {
							await this.abort()
							return this.reportAbortResult(conversation, stats, instrumentedOnProgress)
						}
					}
				} catch (error) {
					if (this.wrapUpRequested && !this.shouldAbort()) {
						continue
					}
					throw error
				}

				usageState.lastRequest = { ...requestUsage }

				const nativeFinalizedToolCalls = toolUseHandler.getAllFinalizedToolUses().map((toolCall, index) => ({
					toolUseId: resolveToolUseId(toolCall, index),
					id: toolCall.id,
					call_id: toolCall.call_id,
					signature: toolCall.signature,
					name: toolCall.name,
					input: toolCall.input,
					isNativeToolCall: true,
				}))
				const parsedNonNativeToolCalls = parseNonNativeToolCalls(assistantText)
				const fallbackNonNativeToolCalls = nativeFinalizedToolCalls.map((toolCall) => ({
					...toolCall,
					isNativeToolCall: false,
				}))

				let finalizedToolCalls: SubagentToolCall[] = []
				if (useNativeToolCalls) {
					finalizedToolCalls = nativeFinalizedToolCalls
				} else if (parsedNonNativeToolCalls.length > 0) {
					finalizedToolCalls = parsedNonNativeToolCalls
				} else if (fallbackNonNativeToolCalls.length > 0) {
					// Defensive fallback: if non-native mode receives structured tool call chunks,
					// execute them but serialize results as plain text to avoid tool_result pairing mismatches.
					Logger.warn(
						"[SubagentRunner] Received structured tool_calls while native tool calling is disabled; falling back to non-native result serialization.",
					)
					finalizedToolCalls = fallbackNonNativeToolCalls
				}
				const assistantContent: DiracContent[] = []
				const thinkingBlock = reasonsHandler.getCurrentReasoning()
				if (thinkingBlock) {
					assistantContent.push({ ...thinkingBlock })
				}
				if (assistantText.trim().length > 0) {
					assistantContent.push({
						type: "text",
						text: assistantText,
						signature: assistantTextSignature,
					} satisfies DiracTextContentBlock)
				}
				if (useNativeToolCalls) {
					assistantContent.push(...finalizedToolCalls.map(toAssistantToolUseBlock))
				}

				if (assistantContent.length > 0) {
					conversation.push({
						role: "assistant",
						content: assistantContent,
						id: requestId,
					})
				}

				if (finalizedToolCalls.length === 0) {
					if (this.wrapUpRequested || this.isWrappingUp) {
						await delay(0)
						continue
					}

					emptyAssistantResponseRetries += 1
					this.recordDiagnostic("retry", this.runState.currentPhase, {
						kind: "empty_assistant_response",
						attempt: emptyAssistantResponseRetries,
					})
					if (emptyAssistantResponseRetries > MAX_EMPTY_ASSISTANT_RETRIES) {
						const error = `Subagent did not call respond with operation "complete". Last response: "${excerpt(assistantText, 200)}"`
						instrumentedOnProgress({ status: SubagentExecutionStatus.FAILED, error, stats: { ...stats } })
						return { status: SubagentExecutionStatus.FAILED, error, stats }
					}

					// Mirror the main loop's no-tools-used nudge so empty/blank model turns
					// can recover without surfacing an immediate hard failure in subagent UI.
					if (assistantContent.length === 0) {
						conversation.push({
							role: "assistant",
							content: [
								{
									type: "text",
									text: "Failure: I did not provide a response.",
								},
							],
							id: requestId,
						})
					}
					conversation.push({
						role: "user",
						content: [
							{
								type: "text",
								text: formatResponse.noToolsUsed(useNativeToolCalls),
							},
						],
					})
					await delay(0)
					continue
				}
				emptyAssistantResponseRetries = 0

				this.enterPhase("executing_tool", "executing finalized tool calls", {
					toolCalls: finalizedToolCalls.map((call) => ({ toolUseId: call.toolUseId, name: call.name })),
				})
				const toolExecResult = await this.toolExecutor.executeToolCalls(
					finalizedToolCalls,
					state,
					requestSnapshot,
					stats,
					instrumentedOnProgress,
					this.wrapUpRequested || this.isWrappingUp,
				)
				this.markActivity("finished finalized tool calls")
				this.baseConfig.taskState.activeSkillIds = [
					...new Set([...this.baseConfig.taskState.activeSkillIds, ...state.activeSkillIds]),
				]
				if (this.shouldAbort()) {
					await this.abort()
					return this.reportAbortResult(conversation, stats, instrumentedOnProgress)
				}
				if (toolExecResult.completed)
					return {
						status: SubagentExecutionStatus.COMPLETED,
						result: toolExecResult.completed.result,
						stats: toolExecResult.completed.stats,
					}

				conversation.push({ role: "user", content: toolExecResult.toolResultBlocks })
				if (this.wrapUpRequested || this.isWrappingUp) {
					await delay(0)
					continue
				}

				this.enterPhase("refreshing_context", "refreshing tool and provider context")
				const refreshedContext = await this.contextBuilder.buildContext()
				state.availableSkills = refreshedContext.context.skills ?? []
				requestSnapshot = refreshedContext.requestSnapshot
				useNativeToolCalls = refreshedContext.useNativeToolCalls
				systemPrompt = this.contextBuilder.appendExecutionDeadline(refreshedContext.systemPrompt, timeout)
				this.markActivity("refreshed tool and provider context")

				await delay(0)
			}
		} catch (error) {
			if (this.shouldAbort()) {
				return this.reportAbortResult(conversation, stats, instrumentedOnProgress)
			}

			const errorText = (error as Error).message || "Subagent execution failed."
			Logger.error("[SubagentRunner] run failed", error)
			instrumentedOnProgress({ status: SubagentExecutionStatus.FAILED, error: errorText, stats: { ...stats } })
			return { status: SubagentExecutionStatus.FAILED, error: errorText, stats }
		} finally {
			this.activeApiAbort = undefined
		}
	}

	private reportAbortResult(
		conversation: DiracStorageMessage[],
		stats: SubagentRunStats,
		onProgress: (update: SubagentProgressUpdate) => void,
	): SubagentRunResult {
		const result = this.abortHandler.buildAbortResult(conversation, stats)
		onProgress(this.toTerminalProgressUpdate(result))
		return result
	}

	private toTerminalProgressUpdate(result: SubagentRunResult): SubagentProgressUpdate {
		return this.runProgress.toTerminalProgressUpdate(result, this.runState.getRuntimeProgress())
	}

	private async drainProgressUpdates(progressUpdates?: Promise<void>, logPrefix?: string): Promise<boolean> {
		return this.runProgress.drainProgressUpdates(progressUpdates, logPrefix)
	}

	private createSubagentTaskConfig(state: TaskState, coordinator: ToolExecutorCoordinator): TaskConfig {
		const baseCallbacks = this.baseConfig.callbacks
		const currentPermissionDecisionBinding = () => this.baseConfig.permissionDecisionBinding

		return {
			...this.baseConfig,
			context: this.baseConfig.context,
			providerId: this.runtime.providerId,
			model: this.runtime.model,
			supportsNativeWebSearch: this.runtime.supportsNativeWebSearch,
			coordinator,
			taskState: state,
			isSubagentExecution: true,
			get permissionDecisionBinding() {
				return currentPermissionDecisionBinding()
			},
			agentIdentity: this.options.agentIdentity,
			vscodeTerminalExecutionMode: "backgroundExec",
			callbacks: {
				...baseCallbacks,
				executeCommandTool: async (command: string, timeoutSeconds: number | undefined) => {
					this.runState.activeCommandExecutions += 1
					this.markActivity("started command tool execution")
					try {
						return await baseCallbacks.executeCommandTool(command, timeoutSeconds, {
							useBackgroundExecution: true,
							suppressUserInteraction: true,
						})
					} finally {
						this.runState.activeCommandExecutions = Math.max(0, this.runState.activeCommandExecutions - 1)
						this.markActivity("finished command tool execution")
					}
				},
			},
		}
	}

	private shouldRetryInitialStreamError(error: unknown, providerId: string, modelId: string): boolean {
		// Mirror main loop behavior: do not auto-retry auth/balance failures.
		const parsedError = DiracError.transform(error, modelId, providerId)
		const isAuthError = parsedError.isErrorType(DiracErrorType.Auth)
		const isBalanceError = parsedError.isErrorType(DiracErrorType.Balance)
		const isPaymentError = parsedError.isErrorType(DiracErrorType.Payment)

		if (isAuthError || isBalanceError || isPaymentError) {
			return false
		}

		return true
	}

	private compactConversationForContextWindow(
		contextManager: ContextManager,
		conversation: DiracStorageMessage[],
		conversationHistoryDeletedRange: [number, number] | undefined,
	): {
		didCompact: boolean
		conversationHistoryDeletedRange: [number, number] | undefined
	} {
		let didCompact = false
		let updatedDeletedRange = conversationHistoryDeletedRange

		const deletedRange = contextManager.getNextTruncationRange(conversation, conversationHistoryDeletedRange, "quarter")
		if (deletedRange[1] < deletedRange[0]) {
			return {
				didCompact,
				conversationHistoryDeletedRange: updatedDeletedRange,
			}
		}

		if (
			conversationHistoryDeletedRange &&
			deletedRange[0] === conversationHistoryDeletedRange[0] &&
			deletedRange[1] === conversationHistoryDeletedRange[1]
		) {
			return {
				didCompact,
				conversationHistoryDeletedRange: updatedDeletedRange,
			}
		}

		updatedDeletedRange = deletedRange
		didCompact = true
		return {
			didCompact,
			conversationHistoryDeletedRange: updatedDeletedRange,
		}
	}

	private shouldCompactBeforeNextRequest(requestTotalTokens: number, configuredContextWindow?: number): boolean {
		const contextWindow = configuredContextWindow || 256_000
		const maxAllowedSize = Math.min(1_000_000, Math.max(contextWindow - 40_000, contextWindow * 0.8))
		const useAutoCondense = this.baseConfig.useAutoCondense
		if (useAutoCondense) {
			const autoCondenseThreshold = 0.75
			const roundedThreshold = Math.floor(contextWindow * autoCondenseThreshold)
			const thresholdTokens = Math.min(roundedThreshold, maxAllowedSize)
			return requestTotalTokens >= thresholdTokens
		}

		return requestTotalTokens >= maxAllowedSize
	}

	private async *createMessageWithInitialChunkRetry(
		runtime: SubagentRuntime,
		systemPrompt: string,
		fullConversation: DiracStorageMessage[],
		nativeTools: DiracTool[] | undefined,
		providerId: string,
		modelId: string,
		contextManager: ContextManager,
		contextState: SubagentContextState,
	) {
		for (let attempt = 1; attempt <= MAX_INITIAL_STREAM_ATTEMPTS; attempt += 1) {
			this.runState.currentAttempt = attempt
			const truncatedConversation = contextManager
				.getTruncatedMessages(fullConversation, contextState.conversationHistoryDeletedRange)
				.map((message) => message as DiracStorageMessage)
			const enableNativeWebSearch =
				runtime.supportsNativeWebSearch &&
				this.activeTaskState?.activeSkillIds.includes(NATIVE_WEB_SEARCH_SKILL_NAME) === true
			this.enterPhase("awaiting_first_provider_chunk", "starting provider request", {
				attempt,
				providerId,
				modelId,
				conversationMessageCount: truncatedConversation.length,
				enableNativeWebSearch,
			})

			let receivedChunk = false
			try {
				const stream = runtime.createMessage(systemPrompt, truncatedConversation, nativeTools, { enableNativeWebSearch })
				const iterator = stream[Symbol.asyncIterator]()
				const firstChunk = await iterator.next()
				this.enterPhase("streaming_provider_response", "received first provider chunk", { attempt, providerId, modelId })
				if (!firstChunk.done) {
					receivedChunk = true
					yield firstChunk.value
				}

				yield* iterator
				this.markActivity("provider stream completed")
				return
			} catch (error) {
				// Retrying a partially consumed stream merges distinct billed requests into one usage snapshot.
				if (receivedChunk) throw error
				if (checkContextWindowExceededError(error)) {
					const compactResult = this.compactConversationForContextWindow(
						contextManager,
						fullConversation,
						contextState.conversationHistoryDeletedRange,
					)
					contextState.conversationHistoryDeletedRange = compactResult.conversationHistoryDeletedRange
					if (!compactResult.didCompact || this.shouldAbort() || attempt >= MAX_INITIAL_STREAM_ATTEMPTS) {
						throw error
					}
					this.recordDiagnostic("retry", this.runState.currentPhase, {
						kind: "context_window_compaction",
						attempt,
						error,
					})
					Logger.warn(
						`[SubagentRunner] Context window exceeded on initial stream attempt ${attempt}; compacted conversation and retrying.`,
					)
					continue
				}

				const shouldRetry =
					!this.shouldAbort() &&
					attempt < MAX_INITIAL_STREAM_ATTEMPTS &&
					this.shouldRetryInitialStreamError(error, providerId, modelId)
				if (!shouldRetry) {
					throw error
				}

				const delayMs = INITIAL_STREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
				this.recordDiagnostic("retry", this.runState.currentPhase, {
					kind: "initial_stream_error",
					attempt,
					nextAttempt: attempt + 1,
					delayMs,
					error,
				})
				Logger.warn(`[SubagentRunner] Initial stream failed. Retrying attempt ${attempt + 1}.`, error)
				await delay(delayMs)
			}
		}
	}

	private runState: SubagentRunState
	private runProgress: SubagentRunProgress
}

export type {
	SubagentProgressUpdate,
	SubagentRunResult,
	SubagentRunStats,
	SubagentRunStatus,
	SubagentToolCall,
} from "./SubagentRunTypes"
