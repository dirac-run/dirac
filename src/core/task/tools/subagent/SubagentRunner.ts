import * as path from "node:path"
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
import type { ApiHandler, buildApiHandler } from "@core/api"
import { parseAssistantMessageV2, ToolParamName, ToolUse } from "@core/assistant-message"
import { getOrDiscoverSkills } from "@core/context/instructions/user-instructions/skills"
import { formatResponse } from "@core/prompts/responses"
import { PromptRegistry } from "@core/prompts/system-prompt"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { StreamResponseHandler } from "@core/task/StreamResponseHandler"
import { DiracAssistantToolUseBlock, DiracStorageMessage, DiracTextContentBlock, DiracUserContent } from "@shared/messages"
import { Logger } from "@shared/services/Logger"
import { DiracDefaultTool, DiracTool } from "@shared/tools"
import { ContextManager } from "@/core/context/context-management/ContextManager"
import { checkContextWindowExceededError } from "@/core/context/context-management/context-error-handling"
import { getContextWindowInfo } from "@/core/context/context-management/context-window-utils"
import { HostRegistryInfo } from "@/registry"
import { DiracError, DiracErrorType } from "@/services/error"
import { calculateApiCostAnthropic } from "@/utils/cost"
import { TaskState } from "../../TaskState"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { SubagentBuilder } from "./SubagentBuilder"
import { excerpt } from "../../utils/excerpt"
import { TOOL_EXAMPLES } from "../../../prompts/tool-examples"

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

interface SubagentProgressUpdate {
	stats?: SubagentRunStats
	latestToolCall?: string
	status?: "running" | "completed" | "failed"
	result?: string
	error?: string
}

interface SubagentRunStats {
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

interface SubagentToolCall {
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

function serializeToolResult(result: unknown): string {
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

function toToolUseParams(input: unknown): Partial<Record<ToolParamName, any>> {
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

function formatToolCallPreview(toolName: string, params: Partial<Record<string, string>>): string {
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
		.filter((block) => !block.partial)
		.map((block, index) => ({
			toolUseId: resolveToolUseId({ call_id: block.call_id, name: block.name }, index),
			name: block.name,
			input: block.params,
			call_id: block.call_id,
			signature: block.signature,
			isNativeToolCall: false,
		}))
}

function pushSubagentToolResultBlock(toolResultBlocks: any[], call: SubagentToolCall, label: string, content: string): void {
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
	private readonly allowedTools: DiracDefaultTool[]
	private activeApiAbort: (() => void) | undefined
	private abortRequested = false
	private abortReason?: string
	private activeCommandExecutions = 0
	private abortingCommands = false
	private gaveTimeoutWrapUpChance = false

	constructor(
		private baseConfig: TaskConfig,
		subagentName = "subagent",
	) {
		this.agent = new SubagentBuilder(baseConfig, subagentName)
		this.apiHandler = this.agent.getApiHandler()
		this.allowedTools = this.agent.getAllowedTools()
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

		onProgress({ status: "running", stats })

		try {
			const mode = this.baseConfig.services.stateManager.getGlobalSettingsKey("mode")
			const apiConfiguration = this.baseConfig.services.stateManager.getApiConfiguration()
			const api = this.apiHandler
			this.activeApiAbort = api.abort?.bind(api)

			const providerId = (
				mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider
			) as string
			const providerInfo = {
				providerId,
				phone: undefined, // Placeholder for missing field if any
				model: api.getModel(),
				mode,
				customPrompt: this.baseConfig.services.stateManager.getGlobalSettingsKey("customPrompt"),
			}
			stats.contextWindow = providerInfo.model.info.contextWindow || 0

			const host = HostRegistryInfo.get()
			const availableSkills = await getOrDiscoverSkills(this.baseConfig.cwd, this.baseConfig.taskState)
			const configuredSkillNames = this.agent.getConfiguredSkills()
			const skills =
				configuredSkillNames !== undefined
					? configuredSkillNames
							.map((skillName) => {
								const skill = availableSkills.find((candidate) => candidate.name === skillName)
								if (!skill) {
									Logger.warn(`[SubagentRunner] Configured skill '${skillName}' not found for subagent run.`)
								}
								return skill
							})
							.filter((skill): skill is (typeof availableSkills)[number] => Boolean(skill))
					: availableSkills

			const context: SystemPromptContext = {
				providerInfo,
				cwd: this.baseConfig.cwd,
				ide: host?.platform || "Unknown",
				skills,
				browserSettings: this.baseConfig.browserSettings,
				yoloModeToggled: false,
				enableParallelToolCalling: false,
				isSubagentRun: true,
				isMultiRootEnabled: this.baseConfig.isMultiRootEnabled,
				workspaceRoots: this.baseConfig.workspaceManager?.getRoots().map((root) => ({
					path: root.path,
					name: root.name || path.basename(root.path),
					vcs: root.vcs,
				})),
			}

			const promptRegistry = PromptRegistry.getInstance()
			const generatedSystemPrompt = await promptRegistry.get(context)
			let systemPrompt = this.agent.buildSystemPrompt(generatedSystemPrompt)
			if (timeout || maxTurns) {
				const limits = []
				if (timeout) {
					limits.push(`${timeout} seconds`)
				}
				if (maxTurns) {
					limits.push(`${maxTurns} turns`)
				}
				systemPrompt += `\n\n# Execution Limits\nYou must complete your task and call attempt_completion within ${limits.join(" and ")}.`
			}
			const nativeTools = this.agent.buildNativeTools(context)
			const useNativeToolCalls = !!nativeTools && nativeTools.length > 0
			const workspaceMetadataEnvironmentBlock = await this.getWorkspaceMetadataEnvironmentBlock()

			if (useNativeToolCalls && (!nativeTools || nativeTools.length === 0)) {
				const error = "Subagent tool requires native tool calling support."
				onProgress({ status: "failed", error, stats })
				return { status: "failed", error, stats }
			}
			if (this.shouldAbort()) {
				await this.abort()
				const reason = this.abortReason || "Subagent run cancelled."
				const isLimitReached = /timed out|maximum turns/.test(this.abortReason || "")

				if (isLimitReached) {
					const partialResult = this.getBestEffortResult(conversation)
					const result = `${reason} This is what I have currently:

${partialResult}`
					onProgress({ status: "completed", result, stats: { ...stats } })
					return { status: "completed", result, stats }
				}

				onProgress({ status: "failed", error: reason, stats: { ...stats } })
				return { status: "failed", error: reason, stats }
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
					const reason = this.abortReason || "Subagent run cancelled."
					const isLimitReached = /timed out|maximum turns/.test(this.abortReason || "")

					if (isLimitReached) {
						const partialResult = this.getBestEffortResult(conversation)
						const result = `${reason} This is what I have currently:

${partialResult}`
						onProgress({ status: "completed", result, stats: { ...stats } })
						return { status: "completed", result, stats }
					}

					onProgress({ status: "failed", error: reason, stats: { ...stats } })
					return { status: "failed", error: reason, stats }
				}

				if (
					usageState.lastRequest &&
					this.shouldCompactBeforeNextRequest(usageState.lastRequest.totalTokens, api, providerInfo.model.id)
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
					nativeTools,
					providerInfo.providerId,
					providerInfo.model.id,
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
							onProgress({ stats: { ...stats } })
							break
						case "text":
							requestId = requestId ?? chunk.id
							assistantText += chunk.text || ""
							assistantTextSignature = chunk.signature || assistantTextSignature
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
						const reason = this.abortReason || "Subagent run cancelled."
						const isLimitReached = /timed out|maximum turns/.test(this.abortReason || "")

						if (isLimitReached) {
							const partialResult = this.getBestEffortResult(conversation)
							const result = `${reason} This is what I have currently:

${partialResult}`
							onProgress({ status: "completed", result, stats: { ...stats } })
							return { status: "completed", result, stats }
						}

						onProgress({ status: "failed", error: reason, stats: { ...stats } })
						return { status: "failed", error: reason, stats }
					}
				}

				const calculatedRequestCost =
					requestUsage.totalCost ??
					calculateApiCostAnthropic(
						providerInfo.model.info,
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
				const assistantContent = [] as any[]
				const thinkingBlock = reasonsHandler.getCurrentReasoning()
				if (thinkingBlock) {
					assistantContent.push({ ...thinkingBlock })
				}
				if (assistantText.trim().length > 0) {
					assistantContent.push({
						type: "text",
						text: assistantText,
						language: undefined, // Placeholder for missing field if any
						signature: assistantTextSignature,
					})
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
						onProgress({ status: "failed", error, stats: { ...stats } })
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

				const toolResultBlocks = [] as DiracUserContent[]
				for (const call of finalizedToolCalls) {
					const toolName = call.name as DiracDefaultTool
					const toolCallParams = toToolUseParams(call.input)

					if (toolName === DiracDefaultTool.ATTEMPT) {
						const completionResult = toolCallParams.result?.trim()
						if (!completionResult) {
							const example = TOOL_EXAMPLES[DiracDefaultTool.ATTEMPT]
							const missingResultError = formatResponse.missingToolParameterError("result", example)
							pushSubagentToolResultBlock(toolResultBlocks, call, toolName, missingResultError)
							continue
						}

						stats.toolCalls += 1
						onProgress({ stats: { ...stats } })
						onProgress({ status: "completed", result: completionResult, stats: { ...stats } })
						return { status: "completed", result: completionResult, stats }
					}

					if (!this.allowedTools.includes(toolName)) {
						const deniedResult = formatResponse.toolError(`Tool '${toolName}' is not available inside subagent runs.`)
						pushSubagentToolResultBlock(toolResultBlocks, call, toolName, deniedResult)
						continue
					}

					const toolCallBlock: ToolUse = {
						type: "tool_use",
						name: toolName,
						params: toolCallParams,
						partial: false,
						isNativeToolCall: call.isNativeToolCall,
						call_id: call.call_id || call.toolUseId,
						signature: call.signature,
					}

					if (call.call_id) {
						state.toolUseIdMap.set(call.call_id, call.toolUseId)
					}

					const latestToolCall = formatToolCallPreview(toolName, toolCallParams)
					onProgress({ latestToolCall })

					const subagentConfig = this.createSubagentTaskConfig(state)
					const handler = this.baseConfig.coordinator.getHandler(toolName)
					let toolResult: unknown

					if (!handler) {
						toolResult = formatResponse.toolError(`No handler registered for tool '${toolName}'.`)
					} else {
						try {
							toolResult = await handler.execute(subagentConfig, toolCallBlock)
						} catch (error) {
							toolResult = formatResponse.toolError((error as Error).message)
						}
					}

					stats.toolCalls += 1
					onProgress({ stats: { ...stats } })

					const serializedToolResult = serializeToolResult(toolResult)
					const toolDescription = handler?.getDescription(toolCallBlock) || `[${toolName}]`
					pushSubagentToolResultBlock(toolResultBlocks, call, toolDescription, serializedToolResult)
				}

				conversation.push({
					role: "user",
					content: toolResultBlocks,
				})

				turnCount++
				await delay(0)
			}
		} catch (error) {
			if (this.shouldAbort()) {
				const reason = this.abortReason || "Subagent run cancelled."
				const isLimitReached = /timed out|maximum turns/.test(this.abortReason || "")

				if (isLimitReached) {
					const partialResult = this.getBestEffortResult(conversation)
					const result = `${reason} This is what I have currently:

${partialResult}`
					onProgress({ status: "completed", result, stats: { ...stats } })
					return { status: "completed", result, stats }
				}

				onProgress({ status: "failed", error: reason, stats: { ...stats } })
				return { status: "failed", error: reason, stats }
			}

			const errorText = (error as Error).message || "Subagent execution failed."
			Logger.error("[SubagentRunner] run failed", error)
			onProgress({ status: "failed", error: errorText, stats: { ...stats } })
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

	private createSubagentTaskConfig(state: TaskState): TaskConfig {
		const baseCallbacks = this.baseConfig.callbacks
		const coordinator = new ToolExecutorCoordinator()
		const validator = new ToolValidator(this.baseConfig.services.diracIgnoreController)

		for (const tool of this.allowedTools) {
			coordinator.registerByName(tool, validator)
		}

		return {
			...this.baseConfig,
			api: this.apiHandler,
			coordinator,
			taskState: state,
			isSubagentExecution: true,
			vscodeTerminalExecutionMode: "backgroundExec",
			callbacks: {
				...baseCallbacks,
				say: async () => undefined,
				sayAndCreateMissingParamError: async (_toolName, paramName) =>
					formatResponse.toolError(formatResponse.missingToolParameterError(paramName, TOOL_EXAMPLES[_toolName as DiracDefaultTool])),
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
