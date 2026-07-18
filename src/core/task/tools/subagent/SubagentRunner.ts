import * as path from "node:path"
import type { ApiHandler, buildApiHandler } from "@core/api"
import { parseAssistantMessageV2, ToolParamName, ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/formatResponse"
import { StreamResponseHandler } from "@core/task/StreamResponseHandler"
import { type ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import { DiracAssistantToolUseBlock, DiracContent, DiracStorageMessage, DiracTextContentBlock } from "@shared/messages"
import { Logger } from "@shared/services/Logger"
import { DiracTool } from "@shared/tools"
import { ContextManager } from "@/core/context/context-management/ContextManager"
import { checkContextWindowExceededError } from "@/core/context/context-management/context-error-handling"
import { getContextWindowInfo } from "@/core/context/context-management/context-window-utils"
import { DiracError, DiracErrorType } from "@/services/error"
import { calculateApiCostAnthropic } from "@/utils/cost"
import { TaskState } from "../../TaskState"
import { excerpt } from "../../utils/excerpt"
import { DiracContext } from "../context/DiracContext"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import { SubagentAbortHandler } from "./SubagentAbortHandler"
import { SubagentBuilder, type SubagentBuilderOptions } from "./SubagentBuilder"
import { SubagentContextBuilder } from "./SubagentContextBuilder"
import { SubagentToolExecutor } from "./SubagentToolExecutor"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_EMPTY_ASSISTANT_RETRIES = 3
const MAX_INITIAL_STREAM_ATTEMPTS = 3
const INITIAL_STREAM_RETRY_BASE_DELAY_MS = 2_000

export type SubagentRunStatus = "completed" | "failed"

export interface SubagentRunResult {
	status: SubagentRunStatus
	result?: string
	error?: string
	stats: SubagentRunStats
}

export interface SubagentProgressUpdate {
	stats?: SubagentRunStats
	latestToolCall?: string
	status?: "running" | "completed" | "failed"
	result?: string
	error?: string
	textChunk?: string
}

export interface SubagentRunStats {
	toolCalls: number
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalCost: number
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
}

interface SubagentRequestUsageState {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalTokens: number
	totalCost?: number
}

interface SubagentUsageState {
	currentRequest: SubagentRequestUsageState
	lastRequest?: SubagentRequestUsageState
}

export interface SubagentToolCall {
	toolUseId: string
	id?: string
	call_id?: string
	signature?: string
	name: string
	input: unknown
	isNativeToolCall: boolean
}

interface SubagentContextState {
	conversationHistoryDeletedRange?: [number, number]
}

function createEmptyRequestUsageState(): SubagentRequestUsageState {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalTokens: 0,
	}
}

export function serializeToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result
	}

	if (Array.isArray(result)) {
		return result
			.map((item) => {
				if (!item || typeof item !== "object") {
					return String(item)
				}

				const maybeText = (item as { text?: string }).text
				if (typeof maybeText === "string") {
					return maybeText
				}

				return JSON.stringify(item)
			})
			.join("")
	}

	return JSON.stringify(result, null, 2)
}

export function toToolUseParams(input: unknown): Partial<Record<ToolParamName, any>> {
	if (!input || typeof input !== "object") {
		return {}
	}

	return input as Partial<Record<ToolParamName, any>>
}

function formatToolArgPreview(value: any, maxLength = 48): string {
	const stringValue = typeof value === "string" ? value : JSON.stringify(value)
	const normalized = stringValue.replace(/\s+/g, " ").trim()
	if (normalized.length <= maxLength) {
		return normalized
	}
	return `${normalized.slice(0, maxLength - 3)}...`
}

export function formatToolCallPreview(toolName: string, params: Partial<Record<string, string>>): string {
	const entries = Object.entries(params).filter(([, value]) => value !== undefined)
	const visibleEntries = entries.slice(0, 3)
	const omittedCount = Math.max(0, entries.length - visibleEntries.length)

	const args = visibleEntries
		.map(([key, value]) => `${key}=${formatToolArgPreview(value ?? "")}`)
		.concat(omittedCount > 0 ? [`...+${omittedCount}`] : [])
		.join(", ")

	return `${toolName}(${args})`
}

function normalizeToolCallArguments(argumentsPayload: unknown): string {
	if (typeof argumentsPayload === "string") {
		return argumentsPayload
	}

	try {
		return JSON.stringify(argumentsPayload ?? {})
	} catch {
		return "{}"
	}
}

function resolveToolUseId(call: { id?: string; call_id?: string; name?: string }, index: number): string {
	const id = call.id?.trim()
	if (id) {
		return id
	}

	const callId = call.call_id?.trim()
	if (callId) {
		return callId
	}

	const fallbackId = `subagent_tool_${Date.now()}_${index + 1}`
	Logger.warn(`[SubagentRunner] Missing tool call id for '${call.name || "unknown"}'; using fallback '${fallbackId}'`)
	return fallbackId
}

function toAssistantToolUseBlock(call: SubagentToolCall): DiracAssistantToolUseBlock {
	return {
		type: "tool_use",
		id: call.toolUseId,
		name: call.name,
		input: call.input,
		call_id: call.call_id,
		signature: call.signature,
	}
}

function parseNonNativeToolCalls(assistantText: string): SubagentToolCall[] {
	const parsedBlocks = parseAssistantMessageV2(assistantText)

	return parsedBlocks
		.filter((block): block is ToolUse => block.type === "tool_use")
		.map((block, index) => ({
			toolUseId: resolveToolUseId({ call_id: block.call_id, name: block.name }, index),
			name: block.name,
			input: block.params,
			call_id: block.call_id,
			signature: block.signature,
			isNativeToolCall: false,
		}))
}

export function pushSubagentToolResultBlock(
	toolResultBlocks: DiracContent[],
	call: SubagentToolCall,
	label: string,
	content: string,
): void {
	if (call.isNativeToolCall) {
		toolResultBlocks.push({
			type: "tool_result",
			tool_use_id: call.toolUseId,
			call_id: call.call_id,
			content,
		})
		return
	}

	toolResultBlocks.push({
		type: "text",
		text: `${label} Result:\n${content}`,
	})
}

export class SubagentRunner {
	private readonly agent: SubagentBuilder
	private readonly apiHandler: ApiHandler
	private readonly allowedTools: string[]
	private readonly contextBuilder: SubagentContextBuilder
	private readonly abortHandler: SubagentAbortHandler
	private readonly toolExecutor: SubagentToolExecutor
	private activeApiAbort: (() => void) | undefined
	private abortRequested = false
	private abortReason?: string
	private activeCommandExecutions = 0
	private abortingCommands = false
	private gaveTimeoutWrapUpChance = false
	private readonly subagentName: string

	constructor(
		private baseConfig: TaskConfig,
		subagentName = "subagent",
		options: SubagentBuilderOptions = {},
	) {
		this.agent = new SubagentBuilder(baseConfig, subagentName, options)
		this.subagentName = subagentName
		this.apiHandler = this.agent.getApiHandler()
		this.allowedTools = this.agent.getAllowedTools()
		this.contextBuilder = new SubagentContextBuilder(baseConfig, this.agent, this.allowedTools, this.apiHandler)
		this.abortHandler = new SubagentAbortHandler(
			() => this.abortReason,
			(conv) => this.getBestEffortResult(conv),
		)
		this.toolExecutor = new SubagentToolExecutor(
			(state, coordinator) => this.createSubagentTaskConfig(state, coordinator),
			(name, snap) => this.isAllowedTool(name, snap),
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

		try {
			this.activeApiAbort?.()
		} catch (error) {
			Logger.error("[SubagentRunner] failed to abort active API stream", error)
		}

		if (this.activeCommandExecutions > 0 && !this.abortingCommands && this.baseConfig.callbacks.cancelRunningCommandTool) {
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
		onProgress: (update: SubagentProgressUpdate) => void,
		timeout?: number,
		maxTurns?: number,
		includeHistory?: boolean,
	): Promise<SubagentRunResult> {
		this.abortRequested = false
		this.abortReason = undefined
		const state = new TaskState()
		state.activeSkillIds = [...this.baseConfig.taskState.activeSkillIds]
		state.availableSkills = this.baseConfig.taskState.availableSkills
		let emptyAssistantResponseRetries = 0
		let conversation: DiracStorageMessage[] = []
		let timeoutHandle: NodeJS.Timeout | undefined
		const contextState: SubagentContextState = {}
		const contextManager = new ContextManager()
		const usageState: SubagentUsageState = {
			currentRequest: createEmptyRequestUsageState(),
		}
		const stats: SubagentRunStats = {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		}

		const logPrefix = `[SubagentRunner:${this.subagentName || "unnamed"}]`
		const instrumentedOnProgress = (update: SubagentProgressUpdate) => {
			if (update.latestToolCall) {
				Logger.debug(`${logPrefix} Tool: ${update.latestToolCall}`)
			}
			if (update.status === "completed" || update.status === "failed") {
				Logger.info(`${logPrefix} ${update.status}: ${(update.result || update.error || "").substring(0, 200)}`)
			}
			onProgress(update)
		}

		instrumentedOnProgress({ status: "running", stats })

		try {
			const api = this.apiHandler
			this.activeApiAbort = api.abort?.bind(api)

			const initialContext = await this.contextBuilder.buildContext()
			const context = initialContext.context
			let requestSnapshot = initialContext.requestSnapshot
			let useNativeToolCalls = initialContext.useNativeToolCalls
			stats.contextWindow = context.providerInfo.model.info.contextWindow || 0
			let systemPrompt = this.contextBuilder.appendExecutionLimits(initialContext.systemPrompt, timeout, maxTurns)
			const workspaceMetadataEnvironmentBlock = await this.getWorkspaceMetadataEnvironmentBlock()

			if (this.shouldAbort()) {
				await this.abort()
				return this.abortHandler.buildAbortResult(conversation, stats, onProgress)
			}

			if (includeHistory) {
				conversation = [...this.baseConfig.messageState.getApiConversationHistory()]
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
			if (timeout) {
				timeoutHandle = setTimeout(() => {
					void this.abort(`Subagent timed out after ${timeout} seconds.`)
				}, timeout * 1000)
			}

			let turnCount = 0
			while (true) {
				if (maxTurns && turnCount === maxTurns - 1) {
					conversation.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "NOTE: This is your last turn. You must provide your final findings now using attempt_completion.",
							} as DiracTextContentBlock,
						],
					})
				}

				if (maxTurns && turnCount >= maxTurns) {
					void this.abort(`Subagent reached maximum turns (${maxTurns}).`)
				}

				if (this.shouldAbort()) {
					if (
						this.abortRequested &&
						this.abortReason &&
						/timed out/.test(this.abortReason) &&
						!this.gaveTimeoutWrapUpChance &&
						!this.baseConfig.taskState.abort
					) {
						this.gaveTimeoutWrapUpChance = true
						if (timeoutHandle) {
							clearTimeout(timeoutHandle)
						}
						timeoutHandle = setTimeout(() => {
							void this.abort("Subagent failed to wrap up after timeout.")
						}, 60000)

						conversation.push({
							role: "user",
							content: [
								{
									type: "text",
									text: "Timeout reached. Please provide your final findings now using attempt_completion based on what you have so far. This is your absolute last turn.",
								} as DiracTextContentBlock,
							],
						})

						this.abortRequested = false
						this.abortReason = undefined
						continue
					}

					await this.abort()
					return this.abortHandler.buildAbortResult(conversation, stats, onProgress)
				}

				if (
					usageState.lastRequest &&
					this.shouldCompactBeforeNextRequest(usageState.lastRequest.totalTokens, api, context.providerInfo.model.id)
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

				let assistantText = ""
				let assistantTextSignature: string | undefined
				let requestId: string | undefined

				const stream = this.createMessageWithInitialChunkRetry(
					api,
					systemPrompt,
					conversation,
					requestSnapshot.nativeTools,
					context.providerInfo.providerId,
					context.providerInfo.model.id,
					contextManager,
					contextState,
				)

				for await (const chunk of stream) {
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
							stats.contextTokens = requestUsage.totalTokens
							stats.contextUsagePercentage =
								stats.contextWindow > 0 ? (stats.contextTokens / stats.contextWindow) * 100 : 0
							instrumentedOnProgress({ stats: { ...stats } })
							break
						case "text":
							requestId = requestId ?? chunk.id
							assistantText += chunk.text || ""
							assistantTextSignature = chunk.signature || assistantTextSignature
							if (chunk.text) {
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
						return this.abortHandler.buildAbortResult(conversation, stats, onProgress)
					}
				}

				const calculatedRequestCost =
					requestUsage.totalCost ??
					calculateApiCostAnthropic(
						context.providerInfo.model.info,
						requestUsage.inputTokens,
						requestUsage.outputTokens,
						requestUsage.cacheWriteTokens,
						requestUsage.cacheReadTokens,
					)
				requestUsage.totalTokens =
					requestUsage.inputTokens +
					requestUsage.outputTokens +
					requestUsage.cacheWriteTokens +
					requestUsage.cacheReadTokens
				stats.totalCost += calculatedRequestCost || 0
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
					emptyAssistantResponseRetries += 1
					if (emptyAssistantResponseRetries > MAX_EMPTY_ASSISTANT_RETRIES) {
						const error = `Subagent did not call attempt_completion. Last response: "${excerpt(assistantText, 200)}"`
						instrumentedOnProgress({ status: "failed", error, stats: { ...stats } })
						return { status: "failed", error, stats }
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

				const toolExecResult = await this.toolExecutor.executeToolCalls(
					finalizedToolCalls,
					state,
					requestSnapshot,
					stats,
					onProgress,
				)
				if (toolExecResult.completed)
					return {
						status: "completed" as const,
						result: toolExecResult.completed.result,
						stats: toolExecResult.completed.stats,
					}

				this.baseConfig.taskState.activeSkillIds = [
					...new Set([...this.baseConfig.taskState.activeSkillIds, ...state.activeSkillIds]),
				]
				const refreshedContext = await this.contextBuilder.buildContext()
				requestSnapshot = refreshedContext.requestSnapshot
				useNativeToolCalls = refreshedContext.useNativeToolCalls
				systemPrompt = this.contextBuilder.appendExecutionLimits(refreshedContext.systemPrompt, timeout, maxTurns)

				conversation.push({ role: "user", content: toolExecResult.toolResultBlocks })

				turnCount++
				await delay(0)
			}
		} catch (error) {
			if (this.shouldAbort()) {
				return this.abortHandler.buildAbortResult(conversation, stats, onProgress)
			}

			const errorText = (error as Error).message || "Subagent execution failed."
			Logger.error("[SubagentRunner] run failed", error)
			instrumentedOnProgress({ status: "failed", error: errorText, stats: { ...stats } })
			return { status: "failed", error: errorText, stats }
		} finally {
			if (typeof timeoutHandle !== "undefined") {
				clearTimeout(timeoutHandle)
			}
			this.activeApiAbort = undefined
		}
	}

	private getBestEffortResult(conversation: DiracStorageMessage[]): string {
		const assistantTexts = conversation
			.filter((msg) => msg.role === "assistant")
			.flatMap((msg) => {
				if (typeof msg.content === "string") {
					return [{ type: "text", text: msg.content } as DiracTextContentBlock]
				}
				return msg.content as DiracTextContentBlock[]
			})
			.filter((block): block is DiracTextContentBlock => block.type === "text")
			.map((block) => block.text.trim())
			.filter((text) => text.length > 0)

		if (assistantTexts.length === 0) {
			return "No findings recorded."
		}

		return assistantTexts.join("\n")
	}

	private createSubagentTaskConfig(state: TaskState, coordinator: ToolExecutorCoordinator): TaskConfig {
		const baseCallbacks = this.baseConfig.callbacks
		// Give the subagent its own isolated task-scoped context so that
		// reads tracked by the subagent (e.g. fileHashes, functionHashes)
		// do not pollute the parent agent's context map.
		const subagentContext = new DiracContext(`${this.baseConfig.taskId}-subagent`, this.baseConfig.services.stateManager)

		return {
			...this.baseConfig,
			context: subagentContext,
			api: this.apiHandler,
			coordinator,
			taskState: state,
			isSubagentExecution: true,
			vscodeTerminalExecutionMode: "backgroundExec",
			callbacks: {
				...baseCallbacks,
				executeCommandTool: async (command: string, timeoutSeconds: number | undefined) => {
					this.activeCommandExecutions += 1
					try {
						return await baseCallbacks.executeCommandTool(command, timeoutSeconds, {
							useBackgroundExecution: true,
							suppressUserInteraction: true,
						})
					} finally {
						this.activeCommandExecutions = Math.max(0, this.activeCommandExecutions - 1)
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

		if (isAuthError || isBalanceError) {
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

	private shouldCompactBeforeNextRequest(
		requestTotalTokens: number,
		api: ReturnType<typeof buildApiHandler>,
		modelId: string,
	): boolean {
		const { contextWindow, maxAllowedSize } = getContextWindowInfo(api)
		const useAutoCondense = this.baseConfig.services.stateManager.getGlobalSettingsKey("useAutoCondense")
		if (useAutoCondense) {
			const autoCondenseThreshold = 0.75
			const roundedThreshold = autoCondenseThreshold ? Math.floor(contextWindow * autoCondenseThreshold) : maxAllowedSize
			const thresholdTokens = Math.min(roundedThreshold, maxAllowedSize)
			return requestTotalTokens >= thresholdTokens
		}

		return requestTotalTokens >= maxAllowedSize
	}

	private async *createMessageWithInitialChunkRetry(
		api: ReturnType<typeof buildApiHandler>,
		systemPrompt: string,
		fullConversation: DiracStorageMessage[],
		nativeTools: DiracTool[] | undefined,
		providerId: string,
		modelId: string,
		contextManager: ContextManager,
		contextState: SubagentContextState,
	) {
		for (let attempt = 1; attempt <= MAX_INITIAL_STREAM_ATTEMPTS; attempt += 1) {
			const truncatedConversation = contextManager
				.getTruncatedMessages(fullConversation, contextState.conversationHistoryDeletedRange)
				.map((message) => message as DiracStorageMessage)
			const stream = api.createMessage(systemPrompt, truncatedConversation, nativeTools)
			const iterator = stream[Symbol.asyncIterator]()

			try {
				const firstChunk = await iterator.next()
				if (!firstChunk.done) {
					yield firstChunk.value
				}

				yield* iterator
				return
			} catch (error) {
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
				Logger.warn(`[SubagentRunner] Initial stream failed. Retrying attempt ${attempt + 1}.`, error)
				await delay(delayMs)
			}
		}
	}
}
