import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ApiHandler } from "@core/api"
import { DiracError, DiracErrorType } from "@services/error"
import { findLastIndex } from "@shared/array"
import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { StateManager } from "../storage/StateManager"
import { MessageStateHandler } from "./message-state"
import { StreamingMetricsManager } from "./StreamingMetricsManager"
import { TaskMessenger } from "./TaskMessenger"
import { TaskState } from "./TaskState"
import { ToolSkippedByUserMessage } from "./tools/types/ToolSkippedByUserMessage"
import { updateApiReqMsg } from "./utils"

// Handles API request errors: classification, retry logic, user prompts.
// Extracted from Task to reduce the 1956-line class.
export class TaskApiErrorHandler {
	constructor(
		private taskState: TaskState,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private taskMessenger: TaskMessenger,
		_stateManager: StateManager,
		private postStateToWebview: () => Promise<void>,
		private handleContextWindowExceededError: () => Promise<void>,
	) {}

	async handleApiRequestError(params: {
		error: unknown
		previousApiReqIndex: number
		lastApiReqIndex: number
		shouldCompact?: boolean
		model: { id: string; info: { contextWindow?: number } }
		providerId: string
		metricsManager: StreamingMetricsManager
	}): Promise<boolean> {
		const { error, model, providerId } = params
		const diracError = DiracError.transform(error, model.id, providerId)

		if (diracError.isErrorType(DiracErrorType.ContextWindowExceeded)) {
			await this.handleContextWindowExceededError()
			const truncatedConversationHistory = this.messageStateHandler.getDiracMessages()
			if (truncatedConversationHistory.length > 3) {
				diracError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
			}
		}

		const streamingFailedMessage = diracError.serialize()

		const lastApiReqStartedIndex = findLastIndex(
			this.messageStateHandler.getDiracMessages(),
			(m) => m.content.type === DiracMessageType.API_STATUS,
		)
		if (lastApiReqStartedIndex !== -1) {
			const diracMessages = this.messageStateHandler.getDiracMessages()
			const msg = diracMessages[lastApiReqStartedIndex]
			if (msg.content.type === DiracMessageType.API_STATUS) {
				const currentApiReqInfo = { ...msg.content.status }
				delete currentApiReqInfo.retryStatus
				await this.messageStateHandler.updateDiracMessage(lastApiReqStartedIndex, {
					content: { type: DiracMessageType.API_STATUS, status: { ...currentApiReqInfo, streamingFailedMessage } },
				})
			}
		}

		const isAuthError = diracError.isErrorType(DiracErrorType.Auth)
		const isDiracProviderInsufficientCredits = (() => {
			if (providerId !== "dirac") return false
			try {
				const parsedError = DiracError.transform(error, model.id, providerId)
				return parsedError.isErrorType(DiracErrorType.Balance)
			} catch {
				return false
			}
		})()

		let response: DiracAskResponse
		if (!isDiracProviderInsufficientCredits && !isAuthError && this.taskState.apiErrorRetryAttempts < 3) {
			this.taskState.apiErrorRetryAttempts++
			const delay = 2000 * 2 ** (this.taskState.apiErrorRetryAttempts - 1)

			await updateApiReqMsg({
				messageStateHandler: this.messageStateHandler,
				lastApiReqIndex: lastApiReqStartedIndex,
				inputTokens: 0,
				reasoningTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: undefined,
				api: this.api,
				cancelReason: "streaming_failed",
				streamingFailedMessage,
			})
			await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			await this.postStateToWebview()

			response = DiracAskResponse.MESSAGE
			await this.taskMessenger.createCard({
				status: CardStatus.ERROR,
				header: "API Error (Retrying)",
				body: JSON.stringify({
					attempt: this.taskState.apiErrorRetryAttempts,
					maxAttempts: 3,
					delaySeconds: delay / 1000,
					errorMessage: streamingFailedMessage,
				}),
			})

			const autoRetryApiReqIndex = findLastIndex(
				this.messageStateHandler.getDiracMessages(),
				(m) => m.content.type === DiracMessageType.API_STATUS,
			)
			if (autoRetryApiReqIndex !== -1) {
				const diracMessages = this.messageStateHandler.getDiracMessages()
				const msg = diracMessages[autoRetryApiReqIndex]
				if (msg.content.type === DiracMessageType.API_STATUS) {
					const currentApiReqInfo = { ...msg.content.status }
					delete currentApiReqInfo.streamingFailedMessage
					await this.messageStateHandler.updateDiracMessage(autoRetryApiReqIndex, {
						content: { type: DiracMessageType.API_STATUS, status: currentApiReqInfo },
					})
				}
			}

			await setTimeoutPromise(delay)
		} else {
			if (!isDiracProviderInsufficientCredits && !isAuthError) {
				await this.taskMessenger.createCard({
					status: CardStatus.ERROR,
					header: "API Error (Retries Exhausted)",
					body: JSON.stringify({
						attempt: 3,
						maxAttempts: 3,
						delaySeconds: 0,
						failed: true,
						errorMessage: streamingFailedMessage,
					}),
				})
			}
			this.taskState.status = TaskStatus.AWAITING_USER_INPUT

			const cardHandle = await this.taskMessenger.createCard({
				status: CardStatus.ERROR,
				requireApproval: true,
				header: "API Request Failed",
				body: streamingFailedMessage,
				actions: [
					{ label: "Retry", value: DiracAskResponse.APPROVE, primary: true },
					{ label: "Cancel", value: DiracAskResponse.REJECT },
				],
			})
			try {
				const askResult = await cardHandle.waitForInteraction()
				response = askResult.response
			} catch (error) {
				if (error instanceof ToolSkippedByUserMessage) {
					await cardHandle.finalize(CardStatus.CANCELLED)
					this.taskState.pendingUserMessage = error.userMessage
					this.taskState.pendingUserImages = error.userImages
					this.taskState.pendingUserFiles = error.userFiles
					response = DiracAskResponse.APPROVE
				} else {
					throw error
				}
			}
			if (response === DiracAskResponse.APPROVE) this.taskState.apiErrorRetryAttempts = 0
		}

		if (response !== DiracAskResponse.APPROVE) throw new Error("API request failed")

		const manualRetryApiReqIndex = findLastIndex(
			this.messageStateHandler.getDiracMessages(),
			(m) => m.content.type === DiracMessageType.API_STATUS,
		)
		if (manualRetryApiReqIndex !== -1) {
			const diracMessages = this.messageStateHandler.getDiracMessages()
			const msg = diracMessages[manualRetryApiReqIndex]
			if (msg.content.type === DiracMessageType.API_STATUS) {
				const currentApiReqInfo = { ...msg.content.status }
				delete currentApiReqInfo.streamingFailedMessage
				await this.messageStateHandler.updateDiracMessage(manualRetryApiReqIndex, {
					content: { type: DiracMessageType.API_STATUS, status: currentApiReqInfo },
				})
			}
		}

		await this.taskMessenger.upsertText("Retrying API request...")
		return true
	}
}
