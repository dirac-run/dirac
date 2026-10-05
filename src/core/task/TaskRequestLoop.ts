import type { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { ErrorService } from "@services/error"
import { telemetryService } from "@services/telemetry"
import type { DiracApiReqCancelReason } from "@shared/ExtensionMessage"
import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import type { DiracContent } from "@shared/messages/content"
import type { DiracMessageModelInfo } from "@shared/messages/metrics"
import { Logger } from "@shared/services/Logger"
import { Session } from "@shared/services/Session"
import { isLocalModel } from "@utils/model-utils"
import type { ApiConversationManager } from "./ApiConversationManager"
import type { LocalConversationCompaction } from "./LocalConversationCompaction"
import type { ResponseProcessor } from "./ResponseProcessor"
import type { TaskRequestRuntime } from "./runtime/TaskRequestRuntime"
import { StreamChunkCoordinator } from "./StreamChunkCoordinator"
import { StreamingMetricsManager } from "./StreamingMetricsManager"
import type { StreamResponseHandler } from "./StreamResponseHandler"
import { attemptApiRequest } from "./TaskApiRequestAttempt"
import { TaskConversationPersistence, type TaskConversationPersistenceHooks } from "./TaskConversationPersistence"
import { type TaskRequestBuilderContext } from "./TaskRequestBuilder"
import { persistApiStopReason, processStreamResult, type TaskRequestOutcomeContext } from "./TaskRequestOutcome"
import {
	appendQueuedSteeringToUserContent,
	rollbackSteeringClaim,
	settleConsumedSteeringClaim,
	type TaskSteeringContext,
} from "./TaskSteering"

export interface TaskRequestLoopContext extends TaskRequestBuilderContext, TaskRequestOutcomeContext {
	requestRuntime: TaskRequestRuntime
	steeringContext: TaskSteeringContext
	handleMistakeLimitReached: (userContent: DiracContent[]) => Promise<{ didEndLoop: boolean; userContent: DiracContent[] }>
	enqueuePreRequestSteeringMessages: () => Promise<void>
	resetStreamingState: () => Promise<void>
	initializeCheckpoints: (isFirstRequest: boolean) => Promise<void>
	determineContextCompaction: (previousApiReqIndex: number) => Promise<boolean>
	localConversationCompaction: LocalConversationCompaction
	responseProcessor: ResponseProcessor
	streamHandler: StreamResponseHandler
	modelContextTracker: ModelContextTracker
	diffViewProvider: DiffViewProvider
	ulid: string
	conversationPersistenceHooks?: TaskConversationPersistenceHooks
}

export async function recursivelyMakeDiracRequests(
	ctx: TaskRequestLoopContext,
	userContent: DiracContent[],
	includeFileDetails = false,
): Promise<boolean> {
	ctx.taskState.status = TaskStatus.PREPARING

	if (ctx.taskState.abort) {
		throw new Error("Task instance aborted")
	}
	await ctx.enqueuePreRequestSteeringMessages()

	const { settings, apiConfiguration } = ctx.requestRuntime.workingConfiguration
	const mode = settings.mode
	const model = ctx.requestRuntime.api.getModel()
	const providerId = (mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider) as string
	const customPrompt = settings.customPrompt
	if (providerId && model.id) {
		try {
			await ctx.modelContextTracker.recordModelUsage(providerId, model.id, mode)
		} catch (error) {
			Logger.error("Failed to record model usage:", error)
		}
	}

	const modelInfo: DiracMessageModelInfo = {
		modelId: model.id,
		providerId: providerId,
		mode: mode,
	}

	const mistakeResult = await ctx.handleMistakeLimitReached(userContent)
	if (mistakeResult.didEndLoop) {
		return true
	}
	userContent = mistakeResult.userContent

	const previousApiStatus = ctx.messageStateHandler.getLatestApiStatusMessage()
	const previousApiReqIndex = previousApiStatus ? ctx.messageStateHandler.findMessageIndexById(previousApiStatus.id) : -1
	const isFirstRequest = previousApiStatus === undefined

	await ctx.initializeCheckpoints(isFirstRequest)

	const useCompactPrompt =
		customPrompt === "compact" && isLocalModel({ model, providerId, customPrompt, mode, supportsNativeWebSearch: false })
	let shouldCompact = await ctx.determineContextCompaction(previousApiReqIndex)
	if (shouldCompact && ctx.localConversationCompaction.isAvailable()) {
		const continuation = await ctx.localConversationCompaction.run({
			source: "automatic",
			triggerApiRequestIndex: previousApiReqIndex,
		})
		if (!continuation) return true

		const compactedContext: DiracContent[] = [{ type: "text", text: continuation }]
		if (ctx.taskState.pinnedContext) {
			compactedContext.push({ type: "text", text: ctx.taskState.pinnedContext })
		}
		userContent = [...compactedContext, ...userContent]
		shouldCompact = false
	}
	const steeringClaim = await appendQueuedSteeringToUserContent(ctx.steeringContext, userContent)

	ctx.taskState.status = TaskStatus.BUILDING_REQUEST

	let apiRequestData: Awaited<ReturnType<ApiConversationManager["prepareApiRequest"]>>
	let steeringClaimConsumed = false
	const conversationPersistence = new TaskConversationPersistence(ctx.conversationPersistenceHooks)
	try {
		apiRequestData = await ctx.apiConversationManager.prepareApiRequest({
			userContent,
			shouldCompact,
			includeFileDetails,
			useCompactPrompt,
			previousApiReqIndex,
			isFirstRequest,
			providerId,
			modelId: model.id,
			mode: modelInfo.mode,
			requestId: ctx.requestRuntime.requestId,
			afterUserContentPersisted: async () => {
				await conversationPersistence.persist(() => ctx.messageStateHandler.flushPendingWrites())
				steeringClaimConsumed = true
				if (!steeringClaim) return
				await settleConsumedSteeringClaim(ctx.steeringContext, steeringClaim)
			},
		})
		await conversationPersistence.rollback()
		if (steeringClaim && !steeringClaimConsumed) {
			if (apiRequestData.didConsumeUserContent) {
				steeringClaimConsumed = true
				await settleConsumedSteeringClaim(ctx.steeringContext, steeringClaim)
			} else {
				await rollbackSteeringClaim(ctx.steeringContext, steeringClaim.id)
			}
		}
	} catch (error) {
		let rollbackError: unknown
		try {
			await conversationPersistence.rollback()
		} catch (failure) {
			rollbackError = failure
		}
		if (steeringClaim && !steeringClaimConsumed) await rollbackSteeringClaim(ctx.steeringContext, steeringClaim.id)
		if (rollbackError) throw new AggregateError([error, rollbackError], "Task conversation persistence rollback failed")
		throw error
	}
	userContent = apiRequestData.userContent
	const lastApiReqIndex = apiRequestData.lastApiReqIndex

	if (apiRequestData.isDirectResponse) {
		if (apiRequestData.directResponseText) {
			await ctx.taskMessenger.upsertText(apiRequestData.directResponseText)
		}
		return true
	}

	try {
		const metricsManager = new StreamingMetricsManager(ctx.messageStateHandler, lastApiReqIndex, ctx.requestRuntime.api)
		let didFinalizeApiReqMsg = false
		let usageChunkSideEffectsQueue = Promise.resolve()

		const queueUsageChunkSideEffects = (
			usageInputTokens: number,
			usageOutputTokens: number,
			chunkOptions?: { cacheWriteTokens?: number; cacheReadTokens?: number; totalCost?: number; stopReason?: string },
		) => {
			usageChunkSideEffectsQueue = usageChunkSideEffectsQueue.then(async () => {
				if (didFinalizeApiReqMsg || ctx.taskState.abort) {
					return
				}

				await metricsManager.updateApiReqMsgFromMetrics()
				await ctx.postStateToWebview()
				await telemetryService.captureTokenUsage(
					ctx.ulid,
					usageInputTokens,
					usageOutputTokens,
					providerId,
					model.id,
					chunkOptions,
				)
			})
		}

		const finalizeApiReqMsg = async (cancelReason?: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
			didFinalizeApiReqMsg = true
			await usageChunkSideEffectsQueue
			await metricsManager.updateApiReqMsgFromMetrics(cancelReason, streamingFailedMessage)

			const metrics = metricsManager.getMetrics()
			ctx.taskState.totalInputTokens += metrics.inputTokens
			ctx.taskState.totalOutputTokens += metrics.outputTokens
			ctx.taskState.totalReasoningTokens += metrics.reasoningTokens
			ctx.taskState.totalCacheWriteTokens += metrics.cacheWriteTokens
			ctx.taskState.totalCacheReadTokens += metrics.cacheReadTokens
			const cost = metricsManager.getTotalCost()
			if (cost !== undefined) ctx.taskState.totalCost += cost

			if (ctx.messageStateHandler.getLatestApiStatusMessage()) {
				ctx.taskState.endApiRequest()
			}
		}

		const abortStream = async (cancelReason: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
			Session.get().finalizeRequest()

			if (ctx.diffViewProvider.isEditing) {
				await ctx.diffViewProvider.revertChanges()
			}

			ctx.taskState.endApiRequest()
			await finalizeApiReqMsg(cancelReason, streamingFailedMessage)
			await ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()

			const metrics = metricsManager.getMetrics()
			await ctx.messageStateHandler.addToApiConversationHistory({
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							assistantMessage +
							`\n\n[${
								cancelReason === "streaming_failed"
									? "Response interrupted by API Error"
									: "Response interrupted by user"
							}]`,
					},
				],
				modelInfo,
				metrics: {
					tokens: {
						prompt: metrics.inputTokens,
						completion: metrics.outputTokens,
						cached: (metrics.cacheWriteTokens ?? 0) + (metrics.cacheReadTokens ?? 0),
					},
					cost: metrics.totalCost,
				},
				ts: Date.now(),
			})

			telemetryService.captureConversationTurnEvent(
				ctx.ulid,
				providerId,
				modelInfo.modelId,
				"assistant",
				modelInfo.mode,
				undefined,
				ctx.taskState.useNativeToolCalls,
			)

			ctx.taskState.markStreamAbortFinished()
		}

		await ctx.resetStreamingState()

		const { toolUseHandler, reasonsHandler } = ctx.streamHandler.getHandlers()
		const stream = attemptApiRequest(ctx, previousApiReqIndex, lastApiReqIndex, shouldCompact)

		let assistantMessageId = ""
		let assistantMessage = ""
		let assistantTextOnly = ""
		let assistantTextSignature: string | undefined

		let didReceiveUsageChunk = false
		let stopReason: string | undefined
		let didFinalizeReasoningForUi = false

		const finalizePendingReasoningMessage = async (thinking: string): Promise<boolean> => {
			const activeVoiceStreamId = ctx.taskState.activeVoiceStreamId
			if (!activeVoiceStreamId) {
				return false
			}

			const message = ctx.messageStateHandler.getMessageById(activeVoiceStreamId)
			if (message?.content.type !== DiracMessageType.MARKDOWN || !message.content.isReasoning) return false

			const previousThinking = message.content.content
			if (thinking.startsWith(previousThinking)) {
				const suffix = thinking.slice(previousThinking.length)
				if (suffix) {
					await ctx.messageStateHandler.appendMarkdownById(activeVoiceStreamId, suffix)
				} else {
					// No suffix means the reasoning already streamed in full. getMessageById above
					// materialized it server-side but emitted no presentation operation, so the
					// client's buffered chunks would never be merged into the message — and once
					// activeVoiceStreamId clears below, the row stops reading the live buffer and
					// renders an empty body. Patch unconditionally, as TaskMessenger.close() does.
					await ctx.messageStateHandler.patchMessageById(activeVoiceStreamId, {
						content: { ...message.content },
					})
				}
			} else if (thinking !== previousThinking) {
				const index = ctx.messageStateHandler.findMessageIndexById(activeVoiceStreamId)
				await ctx.messageStateHandler.updateDiracMessage(index, {
					content: { type: DiracMessageType.MARKDOWN, content: thinking, isReasoning: true },
				})
			}
			await ctx.postStateToWebview()
			ctx.taskState.detachVoiceStream()
			return true
		}

		Session.get().startApiCall()
		ctx.taskState.beginApiRequest()
		let streamCoordinator: StreamChunkCoordinator | undefined

		try {
			streamCoordinator = new StreamChunkCoordinator(stream, {
				onUsageChunk: (chunk) => {
					ctx.streamHandler.setRequestId(chunk.id)
					didReceiveUsageChunk = true
					metricsManager.updateFromChunk(chunk)
					stopReason = chunk.stopReason ?? stopReason
					queueUsageChunkSideEffects(chunk.inputTokens, chunk.outputTokens, {
						cacheWriteTokens: chunk.cacheWriteTokens,
						cacheReadTokens: chunk.cacheReadTokens,
						totalCost: chunk.totalCost,
						stopReason: chunk.stopReason,
					})
				},
			})

			const streamResult = await ctx.responseProcessor.consumeStream(streamCoordinator, {
				abortStream,
				finalizePendingReasoningMessage,
				apiAbort: () => ctx.requestRuntime.api.abort?.(),
			})

			assistantMessage = streamResult.assistantMessage
			assistantTextOnly = streamResult.assistantTextOnly
			assistantTextSignature = streamResult.assistantTextSignature
			assistantMessageId = streamResult.assistantMessageId
			didFinalizeReasoningForUi = streamResult.didFinalizeReasoningForUi
			const shouldInterruptStream = streamResult.shouldInterruptStream

			if (shouldInterruptStream) {
				await streamCoordinator.stop()
			} else {
				await streamCoordinator.waitForCompletion()
			}
			await usageChunkSideEffectsQueue

			if (!ctx.taskState.abort && !didFinalizeReasoningForUi) {
				const finalReasoning = reasonsHandler.getCurrentReasoning()
				if (finalReasoning?.thinking) {
					await finalizePendingReasoningMessage(finalReasoning.thinking)
					didFinalizeReasoningForUi = true
				}
			}
		} catch (error) {
			await streamCoordinator?.stop()
			if (ctx.taskState.abort || ctx.taskState.abandoned) {
				return true
			}

			const diracError = ErrorService.get().toDiracError(error, ctx.requestRuntime.api.getModel().id)
			const errorMessage = diracError.serialize()
			if (ctx.executionProfile !== "standalone") {
				await abortStream("streaming_failed", errorMessage)
				throw diracError
			}
			await ctx.abortTask()
			await abortStream("streaming_failed", errorMessage)
			await ctx.reinitExistingTaskFromId()
			return true
		} finally {
			Session.get().endApiCall()
		}

		if (!didReceiveUsageChunk) {
			const apiStreamUsage = await ctx.requestRuntime.api.getApiStreamUsage?.()
			if (apiStreamUsage) {
				metricsManager.updateFromChunk(apiStreamUsage)
				queueUsageChunkSideEffects(apiStreamUsage.inputTokens, apiStreamUsage.outputTokens, {
					cacheWriteTokens: apiStreamUsage.cacheWriteTokens,
					cacheReadTokens: apiStreamUsage.cacheReadTokens,
					totalCost: apiStreamUsage.totalCost,
					stopReason: apiStreamUsage.stopReason,
				})
			}
		}

		const autoRetryApiStatus = ctx.messageStateHandler.getLatestApiStatusMessage()
		if (autoRetryApiStatus?.content.type === DiracMessageType.API_STATUS) {
			await ctx.messageStateHandler.patchApiStatusById(autoRetryApiStatus.id, {}, ["retryStatus"])
		}

		await finalizeApiReqMsg()
		await persistApiStopReason(ctx, stopReason)
		await ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()
		await ctx.postStateToWebview()

		if (ctx.taskState.abort) {
			throw new Error("Dirac instance aborted")
		}

		const assistantHasContent = await ctx.responseProcessor.routeAssistantResponse({
			assistantMessage,
			assistantTextOnly,
			assistantTextSignature,
			assistantMessageId,
			providerId,
			modelId: model.id,
			mode: modelInfo.mode,
			taskMetrics: metricsManager.getMetrics(),
			modelInfo,
			toolUseHandler,
		})

		return await processStreamResult(ctx, {
			assistantHasContent,
			stopReason,
			userContent,
			metricsManager,
			modelInfo,
			providerId,
			model,
		})
	} catch (error) {
		if (ctx.taskState.abort) {
			// User-initiated abort — not a fatal error, no card needed
			return true
		}
		const diracError = ErrorService.get().toDiracError(error)
		Logger.error("[Task] Fatal error in task loop:", diracError.serialize())
		if (ctx.executionProfile !== "standalone") throw diracError
		try {
			const card = await ctx.taskMessenger.createCard({
				status: CardStatus.ERROR,
				header: "Task Error",
				body: `The task encountered an unexpected error and had to stop.\n\n${diracError.toDisplayMessage()}`,
			})
			await card.finalize(CardStatus.ERROR)
		} catch (sayError) {
			Logger.error("[Task] Failed to emit error message:", sayError)
		}
		return true
	}
}
