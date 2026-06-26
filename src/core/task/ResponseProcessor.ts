import { telemetryService } from "@services/telemetry"
import { DiracApiReqCancelReason } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import type { Mode } from "@shared/storage/types"
import { AssistantMessagePresenter } from "./response/AssistantMessagePresenter"
import { EmptyResponseHandler } from "./response/EmptyResponseHandler"
import { StreamStateSync } from "./response/StreamStateSync"
import { ToolCallExtractor } from "./response/ToolCallExtractor"
import { StreamChunkCoordinator } from "./StreamChunkCoordinator"
import { ResponseProcessorDependencies } from "./types/response-processor"

// Orchestrates assistant response processing — consumes stream chunks, routes
// completed responses, handles empty responses, and delegates to specialized helpers.
export class ResponseProcessor {
	private toolCallExtractor: ToolCallExtractor
	private stateSync: StreamStateSync
	private presenter: AssistantMessagePresenter
	private emptyHandler: EmptyResponseHandler

	constructor(private dependencies: ResponseProcessorDependencies) {
		this.toolCallExtractor = new ToolCallExtractor(dependencies.streamHandler, dependencies.taskState)
		this.stateSync = new StreamStateSync(dependencies.streamHandler, dependencies.taskState)
		this.presenter = new AssistantMessagePresenter(dependencies)
		this.emptyHandler = new EmptyResponseHandler(dependencies)
	}

	public resetStreamState() {
		this.presenter.resetState()
	}

	// Passthrough for tests — sanitizes model quirks (delegates to ResponseFormatter).
	public sanitizeModelQuirks(content: string): string {
		return this.presenter.sanitizeModelQuirks(content)
	}

	// Passthrough for tests — exposes pending presentation error from presenter.
	public get pendingPresentationError(): Error | undefined { return this.presenter.pendingPresentationError }
	public set pendingPresentationError(e: Error | undefined) { this.presenter.pendingPresentationError = e }

	public async consumeStream(
		streamCoordinator: StreamChunkCoordinator,
		callbacks: {
			abortStream: (reason: DiracApiReqCancelReason) => Promise<void>
			finalizePendingReasoningMessage: (thinking: string) => Promise<boolean>
			apiAbort: () => void
		},
	): Promise<{
		assistantMessage: string
		assistantTextOnly: string
		assistantTextSignature?: string
		assistantMessageId: string
		shouldInterruptStream: boolean
		didFinalizeReasoningForUi: boolean
	}> {
		let assistantMessageId = ""
		let assistantMessage = ""
		let assistantTextOnly = ""
		let assistantTextSignature: string | undefined
		let didFinalizeReasoningForUi = false
		let shouldInterruptStream = false

		const { toolUseHandler, reasonsHandler } = this.dependencies.streamHandler.getHandlers()

		while (true) {
			const chunk = await streamCoordinator.nextChunk()
			if (!chunk) break
			if (!this.dependencies.taskState.taskFirstTokenTimeMs) {
				this.dependencies.taskState.taskFirstTokenTimeMs = Math.max(
					0,
					Date.now() - this.dependencies.taskState.taskStartTimeMs,
				)
			}

			switch (chunk.type) {
				case "reasoning": {
					const details = chunk.details ? (Array.isArray(chunk.details) ? chunk.details : [chunk.details]) : []
					this.dependencies.streamHandler.processReasoningDelta({
						id: chunk.id,
						reasoning: chunk.reasoning,
						signature: chunk.signature,
						details,
						redacted_data: chunk.redacted_data,
					})
					await this.syncStreamState(assistantTextOnly, toolUseHandler.getParsedToolUseStates())
					break
				}
				case "tool_calls": {
					this.toolCallExtractor.processToolCallChunk(chunk)
					await this.syncStreamState(assistantTextOnly, toolUseHandler.getParsedToolUseStates())
					break
				}
				case "text": {
					const currentReasoning = reasonsHandler.getCurrentReasoning()
					if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
						const finalizedReasoning = await callbacks.finalizePendingReasoningMessage(currentReasoning.thinking)
						if (finalizedReasoning) didFinalizeReasoningForUi = true
					}
					if (chunk.signature) assistantTextSignature = chunk.signature
					this.dependencies.streamHandler.processTextDelta(chunk)
					if (chunk.id) assistantMessageId = chunk.id
					assistantMessage += chunk.text
					assistantTextOnly += chunk.text
					const prevLength = this.dependencies.taskState.assistantMessageContent.length
					await this.syncStreamState(assistantTextOnly, toolUseHandler.getParsedToolUseStates())
					if (this.dependencies.taskState.assistantMessageContent.length > prevLength) {
						this.dependencies.taskState.userMessageContentReady = false
					}
					break
				}
			}
			this.presenter.present().catch((error) => {
				Logger.error("[Task] Presentation error during streaming:", error)
				this.presenter.pendingPresentationError = error
			})

			if (this.dependencies.taskState.abort) {
				callbacks.apiAbort()
				if (!this.dependencies.taskState.abandoned) await callbacks.abortStream("user_cancelled")
				shouldInterruptStream = true
				break
			}
			if (this.dependencies.taskState.didRejectTool) {
				assistantMessage += "\n\n[Response interrupted by user feedback]"
				shouldInterruptStream = true
				break
			}
		}

		return {
			assistantMessage,
			assistantTextOnly,
			assistantTextSignature,
			assistantMessageId,
			shouldInterruptStream,
			didFinalizeReasoningForUi,
		}
	}

	public async routeAssistantResponse(params: {
		assistantMessage: string
		assistantTextOnly: string
		assistantTextSignature?: string
		assistantMessageId: string
		providerId: string
		modelId: string
		mode: Mode
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		modelInfo: any
		toolUseHandler: any
	}): Promise<boolean> {
		const assistantContent = this.dependencies.streamHandler.getOrderedBlocks()
		const assistantHasContent = assistantContent.length > 0 || params.assistantMessage.length > 0

		if (assistantHasContent) {
			telemetryService.captureConversationTurnEvent(
				this.dependencies.ulid,
				params.providerId,
				params.modelId,
				"assistant",
				params.mode,
				params.taskMetrics,
				this.dependencies.taskState.useNativeToolCalls,
			)
			const requestId = this.dependencies.streamHandler.requestId
			if (assistantContent.length > 0) {
				await this.dependencies.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: assistantContent,
					modelInfo: params.modelInfo,
					id: requestId,
					metrics: {
						tokens: {
							prompt: params.taskMetrics.inputTokens,
							completion: params.taskMetrics.outputTokens,
							cached: (params.taskMetrics.cacheWriteTokens ?? 0) + (params.taskMetrics.cacheReadTokens ?? 0),
						},
						cost: params.taskMetrics.totalCost,
					},
					ts: Date.now(),
				})
			}
		}

		this.dependencies.taskState.didCompleteReadingStream = true
		const partialToolBlocks = params.toolUseHandler.getParsedToolUseStates(true)
		await this.syncStreamState(params.assistantTextOnly, partialToolBlocks, true)

		if (this.presenter.pendingPresentationError) {
			const err = this.presenter.pendingPresentationError
			this.presenter.pendingPresentationError = undefined
			throw err
		}
		await this.presenter.present()
		return assistantHasContent
	}

	public async handleEmptyAssistantResponse(params: {
		modelInfo: any
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		providerId: string
		model: any
	}): Promise<boolean> {
		return this.emptyHandler.handleEmptyResponse(params)
	}

	public async presentAssistantMessage() {
		return this.presenter.present()
	}

	public async syncStreamState(assistantTextOnly: string, toolBlocks: any[] = [], isStreamComplete = false) {
		this.stateSync.syncStreamState(assistantTextOnly, toolBlocks, isStreamComplete)
	}
}
