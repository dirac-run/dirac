import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import type { ApiHandler } from "@core/api"
import type { ApiStream } from "@core/api/transform/stream"
import { formatResponse } from "@core/formatResponse"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { DiracError, DiracErrorType } from "@services/error"
import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracContent, DiracTextContentBlock } from "@shared/messages/content"
import type { DiracMessageModelInfo } from "@shared/messages/metrics"
import type { Mode } from "@shared/storage/types"
import { isMutatingTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import type { MessageStateHandler } from "./message-state"
import type { StreamingMetricsManager } from "./StreamingMetricsManager"
import type { TaskMessenger } from "./TaskMessenger"
import type { TaskState } from "./TaskState"
import { ToolSkippedByUserMessage } from "./tools/types/ToolSkippedByUserMessage"
import { updateApiReqMsg } from "./utils"
import type { TaskExecutionProfile } from "./TaskExecutionProfile"

export interface TaskRequestOutcomeContext {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	taskMessenger: TaskMessenger
	api: ApiHandler
	taskId: string
	mode: Mode
	executionProfile: TaskExecutionProfile
	checkpointManager?: ICheckpointManager
	postStateToWebview: () => Promise<void>
	abortTask: () => Promise<void>
	handleContextWindowExceededError: () => Promise<void>
	reinitExistingTaskFromId: () => Promise<void>
	attemptApiRequest: (previousApiReqIndex: number, lastApiReqIndex: number, shouldCompact?: boolean) => ApiStream
	recursivelyMakeDiracRequests: (userContent: DiracContent[], includeFileDetails?: boolean) => Promise<boolean>
	handleEmptyAssistantResponse: (params: {
		modelInfo: DiracMessageModelInfo
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		providerId: string
		model: { id: string }
	}) => Promise<boolean>
}

export async function handleApiRequestError(
	ctx: TaskRequestOutcomeContext,
	params: {
		error: unknown
		previousApiReqIndex: number
		lastApiReqIndex: number
		shouldCompact?: boolean
		model: { id: string; info: { contextWindow?: number } }
		providerId: string
		metricsManager: StreamingMetricsManager
	},
): Promise<boolean> {
	const { error, model, providerId } = params
	const diracError = DiracError.transform(error, model.id, providerId)

	if (diracError.isErrorType(DiracErrorType.ContextWindowExceeded)) {
		await ctx.handleContextWindowExceededError()
		const truncatedConversationHistory = ctx.messageStateHandler.getDiracMessages()
		if (truncatedConversationHistory.length > 3) {
			diracError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
		}
	}

	const streamingFailedMessage = diracError.serialize()

	const lastApiStatus = ctx.messageStateHandler.getLatestApiStatusMessage()
	const lastApiReqStartedIndex = lastApiStatus
		? ctx.messageStateHandler.findMessageIndexById(lastApiStatus.id)
		: -1
	if (lastApiStatus?.content.type === DiracMessageType.API_STATUS) {
		await ctx.messageStateHandler.patchApiStatusById(
			lastApiStatus.id,
			{ streamingFailedMessage },
			["retryStatus"],
		)
	}

	const isAuthError = diracError.isErrorType(DiracErrorType.Auth)
	const isPaymentError = diracError.isErrorType(DiracErrorType.Payment)

	let response: DiracAskResponse
	if (!isAuthError && !isPaymentError && ctx.taskState.apiErrorRetryAttempts < 3) {
		ctx.taskState.apiErrorRetryAttempts++
		const delay = 2000 * 2 ** (ctx.taskState.apiErrorRetryAttempts - 1)

		await updateApiReqMsg({
			messageStateHandler: ctx.messageStateHandler,
			lastApiReqIndex: lastApiReqStartedIndex,
			inputTokens: 0,
			reasoningTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: undefined,
			api: ctx.api,
			cancelReason: "streaming_failed",
			streamingFailedMessage,
		})
		await ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()
		await ctx.postStateToWebview()

		response = DiracAskResponse.APPROVE
		const autoRetryCard = await ctx.taskMessenger.createCard({
			status: CardStatus.PENDING,
			header: "API Error (Retrying)",
			body: `API Error (attempt ${ctx.taskState.apiErrorRetryAttempts}/3). Retrying in ${delay / 1000}s...`,
		})

		const autoRetryApiStatus = ctx.messageStateHandler.getLatestApiStatusMessage()
		if (autoRetryApiStatus?.content.type === DiracMessageType.API_STATUS) {
			await ctx.messageStateHandler.patchApiStatusById(autoRetryApiStatus.id, {}, ["streamingFailedMessage"])
		}

		const deadline = Date.now() + delay
		while (Date.now() < deadline && !ctx.taskState.abort) {
			await setTimeoutPromise(Math.min(200, deadline - Date.now()))
		}
		// If the user aborted during the retry delay, stop retrying
		if (ctx.taskState.abort) {
			await autoRetryCard.update({
				header: "API Error (Cancelled)",
				body: `API Error (attempt ${ctx.taskState.apiErrorRetryAttempts}/3). Cancelled.`,
			})
			await autoRetryCard.finalize(CardStatus.CANCELLED)
			throw new Error("Task instance aborted")
		}
		await autoRetryCard.update({ body: `API Error (attempt ${ctx.taskState.apiErrorRetryAttempts}/3). Retrying...` })
		await autoRetryCard.finalize(CardStatus.ERROR)
	} else {
		if (!isAuthError && !isPaymentError) {
			await ctx.taskMessenger.createCard({
				status: CardStatus.ERROR,
				header: "API Error (Retries Exhausted)",
				body: `The API request failed after 3 attempts. ${diracError.toDisplayMessage()}`,
			})
		}
		if (isPaymentError) {
			await ctx.taskMessenger.createCard({
				status: CardStatus.ERROR,
				header: "API Error (Payment Required)",
				body: diracError.toDisplayMessage(),
			})
		}
		if (isAuthError) {
			await ctx.taskMessenger.createCard({
				status: CardStatus.ERROR,
				header: "API Error (Authentication)",
				body: diracError.toDisplayMessage(),
			})
		}
		ctx.taskState.status = TaskStatus.AWAITING_USER_INPUT

		const cardHandle = await ctx.taskMessenger.createCard({
			requireApproval: true,
			header: "API Request Failed",
			body: diracError.toDisplayMessage(),
			actions: [
				{ label: "Retry", value: DiracAskResponse.APPROVE, primary: true },
				{ label: "Cancel", value: DiracAskResponse.REJECT },
			],
		})
		try {
			const askResult = await cardHandle.waitForInteraction()
			response = askResult.response
			await cardHandle.finalize(
				response === DiracAskResponse.APPROVE ? CardStatus.SUCCESS : CardStatus.CANCELLED,
			)
		} catch (error) {
			if (error instanceof ToolSkippedByUserMessage) {
				await cardHandle.finalize(CardStatus.SKIPPED)
				ctx.taskState.pendingUserMessage = error.userMessage
				ctx.taskState.pendingUserImages = error.userImages
				ctx.taskState.pendingUserFiles = error.userFiles
				response = DiracAskResponse.APPROVE
			} else {
				throw error
			}
		}
		if (response === DiracAskResponse.APPROVE) {
			ctx.taskState.apiErrorRetryAttempts = 0
		}
	}

	if (response !== DiracAskResponse.APPROVE) {
		await ctx.abortTask()
		if (ctx.executionProfile === "standalone") await ctx.reinitExistingTaskFromId()
		return false
	}

	const manualRetryApiStatus = ctx.messageStateHandler.getLatestApiStatusMessage()
	if (manualRetryApiStatus?.content.type === DiracMessageType.API_STATUS) {
		await ctx.messageStateHandler.patchApiStatusById(manualRetryApiStatus.id, {}, ["streamingFailedMessage"])
	}

	await ctx.taskMessenger.upsertText("Retrying API request...")

	return true
}

export async function processStreamResult(
	ctx: TaskRequestOutcomeContext,
	params: {
		assistantHasContent: boolean
		stopReason?: string
		userContent: DiracContent[]
		metricsManager: StreamingMetricsManager
		modelInfo: DiracMessageModelInfo
		providerId: string
		model: { id: string }
	},
): Promise<boolean> {
	if (params.assistantHasContent) {
		ctx.taskState.askResponse = undefined
		ctx.taskState.askResponseText = undefined
		ctx.taskState.askResponseImages = undefined
		ctx.taskState.askResponseFiles = undefined
		ctx.taskState.status = TaskStatus.AWAITING_USER_INPUT

		await pWaitFor(() => ctx.taskState.userMessageContentReady)
		const hasMutatingTools = ctx.taskState.assistantMessageContent.some(
			(block) => block.type === "tool_use" && isMutatingTool(block.name),
		)
		if (hasMutatingTools) {
			await ctx.checkpointManager?.saveCheckpoint()
		}

		const didToolUse = ctx.taskState.assistantMessageContent.some((block) => block.type === "tool_use")
		if (ctx.taskState.didAttemptCompletion) {
			ctx.taskState.completionCommitted = false
			ctx.taskState.status = TaskStatus.COMPLETED
			await ctx.postStateToWebview()
			return true
		}
		const hitTokenLimit =
			params.stopReason === "MAX_TOKENS" || params.stopReason === "max_tokens" || params.stopReason === "length"

		if (!didToolUse) {
			ctx.taskState.userMessageContent.push({
				type: "text",
				text: hitTokenLimit
					? "You reached the output token limit. Continue from where you stopped; restart an interrupted tool call, or call respond with operation 'complete' if finished."
					: formatResponse.noToolsUsed(ctx.taskState.useNativeToolCalls, ctx.mode),
			} as DiracTextContentBlock)
			ctx.taskState.consecutiveMistakeCount++
		}

		ctx.taskState.apiErrorRetryAttempts = 0
		ctx.taskState.emptyResponseRetryAttempts = 0

		if (
			ctx.taskState.pendingUserMessage !== undefined ||
			(ctx.taskState.pendingUserImages?.length ?? 0) > 0 ||
			(ctx.taskState.pendingUserFiles?.length ?? 0) > 0
		) {
			if (ctx.taskState.pendingUserMessage) {
				ctx.taskState.userMessageContent.push({
					type: "text",
					text: `<feedback>\n${ctx.taskState.pendingUserMessage}\n</feedback>`,
					isUserInput: true,
				} as DiracTextContentBlock)
			}
			if (ctx.taskState.pendingUserImages?.length) {
				ctx.taskState.userMessageContent.push(...formatResponse.imageBlocks(ctx.taskState.pendingUserImages))
			}
			if (ctx.taskState.pendingUserFiles?.length) {
				const fileContent = await processFilesIntoText(ctx.taskState.pendingUserFiles)
				if (fileContent) {
					ctx.taskState.userMessageContent.push({ type: "text", text: fileContent } as DiracTextContentBlock)
				}
			}
			ctx.taskState.pendingUserMessage = undefined
			ctx.taskState.pendingUserImages = undefined
			ctx.taskState.pendingUserFiles = undefined
		}

		return await ctx.recursivelyMakeDiracRequests(ctx.taskState.userMessageContent)
	}
	const taskMetrics = params.metricsManager.getMetrics()
	const shouldRetry = await ctx.handleEmptyAssistantResponse({
		modelInfo: params.modelInfo,
		taskMetrics,
		providerId: params.providerId,
		model: params.model,
	})
	if (shouldRetry === false) {
		ctx.taskState.consecutiveMistakeCount = 0
		return await ctx.recursivelyMakeDiracRequests(params.userContent)
	}
	return true
}

export async function persistApiStopReason(ctx: TaskRequestOutcomeContext, stopReason?: string): Promise<void> {
	if (!stopReason) return

	const message = ctx.messageStateHandler.getLatestApiStatusMessage()
	if (message?.content.type !== DiracMessageType.API_STATUS) return

	await ctx.messageStateHandler.patchApiStatusById(message.id, { stopReason })
}
