import { transcriptHash, TranscriptIntegrityError } from "@core/api/TranscriptPrefix"
import type { ApiConversationManager } from "./ApiConversationManager"
import { ApiStream } from "@core/api/transform/stream"
import { recordSuccessfulModelProviderPreset } from "@core/models/modelProviderPresets"
import type { ApiProvider } from "@shared/api"
import type { DiracApiReqCancelReason } from "@shared/ExtensionMessage"
import { TaskStatus } from "@shared/ExtensionMessage"
import type { DiracStorageMessage } from "@shared/messages/content"
import { removeProviderBoundaryMetadataFromMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { StreamingMetricsManager } from "./StreamingMetricsManager"
import { buildApiRequestParams } from "./TaskRequestBuilder"
import type { TaskRequestLoopContext } from "./TaskRequestLoop"
import { handleApiRequestError } from "./TaskRequestOutcome"
import { appendQueuedSteeringToNextApiRequest } from "./TaskSteering"

interface SealedAttempt {
	request: Awaited<ReturnType<typeof buildApiRequestParams>>
	dispatch: Awaited<ReturnType<ApiConversationManager["prepareProviderConversationDispatch"]>>
	fingerprint: string
}

function attemptFingerprint(request: SealedAttempt["request"], dispatch: SealedAttempt["dispatch"]): string {
	return transcriptHash({
		systemPrompt: request.systemPrompt,
		tools: request.toolSnapshot.nativeTools,
		providerId: request.providerInfo.providerId,
		modelId: request.providerInfo.model.id,
		messages: dispatch.messages,
		options: dispatch.options,
	})
}

export async function* attemptApiRequest(
	ctx: TaskRequestLoopContext,
	previousApiReqIndex: number,
	lastApiReqIndex: number,
	shouldCompact?: boolean,
	metricsManager = new StreamingMetricsManager(ctx.messageStateHandler, lastApiReqIndex, ctx.requestRuntime.api),
	settleUsageSideEffects?: () => Promise<void>,
	sealedAttempt?: SealedAttempt,
): ApiStream {
	const requestPreparationStartedAt = performance.now()
	const request = sealedAttempt?.request ?? await buildApiRequestParams(ctx, ctx.requestRuntime, { previousApiReqIndex, shouldCompact })
	if (sealedAttempt && attemptFingerprint(request, sealedAttempt.dispatch) !== sealedAttempt.fingerprint) {
		throw new TranscriptIntegrityError("sealed request retry")
	}
	const { systemPrompt, toolSnapshot, contextManagementMetadata, providerInfo } = request
	const { model, providerId } = providerInfo


	const finalizeApiReqMsg = async (cancelReason?: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
		await metricsManager.updateApiReqMsgFromMetrics(cancelReason, streamingFailedMessage)
		await ctx.messageStateHandler.updateDiracMessage(lastApiReqIndex, {})
		ctx.taskState.endApiRequest()
	}

	const abortStream = async (cancelReason: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
		ctx.taskState.markStreamAbortFinished()
		await finalizeApiReqMsg(cancelReason, streamingFailedMessage)
		ctx.taskState.endApiRequest()
	}

	if (!sealedAttempt) {
		await appendQueuedSteeringToNextApiRequest(ctx.steeringContext, contextManagementMetadata.truncatedConversationHistory)
		await ctx.deliverTaskletEvents?.(contextManagementMetadata.truncatedConversationHistory)
	}
	const providerDispatch = sealedAttempt?.dispatch ?? await ctx.apiConversationManager.prepareProviderConversationDispatch({
		systemPrompt,
		tools: toolSnapshot.nativeTools,
		truncatedMessages: contextManagementMetadata.truncatedConversationHistory as DiracStorageMessage[],
		providerId,
		modelId: model.id,
	})

	if (ctx.taskState.abort) throw new Error("Task instance aborted")
	Logger.debug(
		`[Task ${ctx.taskId}] Request assembled for ${providerId}/${model.id} in ${Math.round(performance.now() - requestPreparationStartedAt)}ms`,
	)

	const fingerprint = sealedAttempt?.fingerprint ?? attemptFingerprint(request, providerDispatch)
	const stream = ctx.requestRuntime.api.createMessage(
		systemPrompt,
		structuredClone(providerDispatch.messages.map(removeProviderBoundaryMetadataFromMessage)),
		structuredClone(toolSnapshot.nativeTools),
		structuredClone(providerDispatch.options),
	)
	const iterator = stream[Symbol.asyncIterator]()
	let emittedOutput = false

	try {
		ctx.taskState.status = TaskStatus.WAITING_FOR_API
		await ctx.postStateToWebview()
		if (ctx.taskState.abort) throw new Error("Task instance aborted")

		ctx.taskState.beginFirstChunkWait()
		const firstChunk = await iterator.next().finally(() => {
			ctx.taskState.endFirstChunkWait()
		})

		if (firstChunk.done) {
			await finalizeApiReqMsg()
			return
		}

		emittedOutput = firstChunk.value.type !== "usage"
		if (firstChunk.value.type === "usage") metricsManager.updateFromChunk(firstChunk.value)
		yield firstChunk.value

		for await (const chunk of iterator) {
			if (ctx.taskState.abort) {
				await abortStream("user_cancelled")
				return
			}

			if (chunk.type === "usage") {
				metricsManager.updateFromChunk(chunk)
				yield chunk
				continue
			}

			emittedOutput = true
			yield chunk
		}

		// Contained model selections must not recapture or mutate foreground provider defaults.
		if (ctx.executionProfile !== "tasklet") {
			recordSuccessfulModelProviderPreset(ctx.stateManager, providerId as ApiProvider, model.id, model.info, providerInfo.mode)
		}
		await finalizeApiReqMsg()
	} catch (error) {
		if (error instanceof TranscriptIntegrityError) throw error
		// Once output is exposed, replaying this request would append a second response
		// to the same stream. Let the outer loop persist the interrupted turn instead.
		if (emittedOutput) throw error
		await settleUsageSideEffects?.()
		const shouldRetry = await handleApiRequestError(ctx, {
			error,
			previousApiReqIndex,
			lastApiReqIndex,
			shouldCompact,
			model,
			providerId,
			metricsManager,
		})
		if (shouldRetry) {
			if (attemptFingerprint(request, providerDispatch) !== fingerprint) {
				throw new TranscriptIntegrityError("sealed request retry")
			}
			yield* attemptApiRequest(ctx, previousApiReqIndex, lastApiReqIndex, shouldCompact, metricsManager, settleUsageSideEffects,
				ctx.taskState.pendingApiConversationCompaction ? undefined : { request, dispatch: providerDispatch, fingerprint })
		}
		return
	}
}
