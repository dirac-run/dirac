import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { ToolSkippedByUserMessage } from "../tools/types/ToolSkippedByUserMessage"
import { ResponseProcessorDependencies } from "../types/response-processor"

const BASE_ERROR_MESSAGE =
	"Invalid API Response: The provider returned an empty or unparsable response. This is a provider-side issue where the model failed to generate valid output or returned tool calls that Dirac cannot process. Retrying the request may help resolve this issue."
const NO_RESPONSE_ERROR_MESSAGE = "No assistant message was received. Would you like to retry the request?"
const MAX_RETRY_ATTEMPTS = 3

// Handles empty assistant responses — creates error cards, auto-retries with
// exponential backoff, and prompts user for manual retry after max attempts.
export class EmptyResponseHandler {
	constructor(private deps: ResponseProcessorDependencies) {}

	async handleEmptyResponse(params: {
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
		const reqId = this.deps.getApiRequestIdSafe()
		await this.createErrorCard(reqId)
		await this.recordFailureInHistory(params)
		return this.handleRetry()
	}

	// Create the initial API error card
	private async createErrorCard(reqId: string | undefined): Promise<void> {
		const errorText = reqId ? `${BASE_ERROR_MESSAGE} (Request ID: ${reqId})` : BASE_ERROR_MESSAGE
		const card = await this.deps.taskMessenger.createCard({ header: "API Error", body: errorText, status: CardStatus.ERROR })
		await card.finalize(CardStatus.ERROR)
	}

	// Record the failure in API conversation history
	private async recordFailureInHistory(params: { modelInfo: any; taskMetrics: any }): Promise<void> {
		await this.deps.messageStateHandler.addToApiConversationHistory({
			role: "assistant",
			content: [{ type: "text", text: "Failure: I did not provide a response." }],
			modelInfo: params.modelInfo,
			id: this.deps.streamHandler.requestId,
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

	// Handle retry logic — auto-retry with backoff or prompt user
	private async handleRetry(): Promise<boolean> {
		if (this.deps.taskState.emptyResponseRetryAttempts < MAX_RETRY_ATTEMPTS) return this.autoRetry()
		return this.promptManualRetry()
	}

	// Auto-retry with exponential backoff
	private async autoRetry(): Promise<boolean> {
		this.deps.taskState.emptyResponseRetryAttempts++
		const delay = 2000 * 2 ** (this.deps.taskState.emptyResponseRetryAttempts - 1)
		const card = await this.deps.taskMessenger.createCard({
			header: "Auto-Retry",
			body: JSON.stringify({
				attempt: this.deps.taskState.emptyResponseRetryAttempts,
				maxAttempts: MAX_RETRY_ATTEMPTS,
				delaySeconds: delay / 1000,
				errorMessage: NO_RESPONSE_ERROR_MESSAGE,
			}),
			status: CardStatus.PENDING,
		})
		await setTimeoutPromise(delay)
		await card.finalize(CardStatus.SUCCESS)
		return false // retry requested
	}

	// Prompt user for manual retry after auto-retry exhaustion
	private async promptManualRetry(): Promise<boolean> {
		const cardHandle = await this.deps.taskMessenger.createCard({
			header: "Auto-Retry Failed",
			body: JSON.stringify({
				attempt: MAX_RETRY_ATTEMPTS,
				maxAttempts: MAX_RETRY_ATTEMPTS,
				delaySeconds: 0,
				failed: true,
				errorMessage: NO_RESPONSE_ERROR_MESSAGE,
			}),
			status: CardStatus.ERROR,
			requireApproval: true,
			actions: [
				{ label: "Retry", value: DiracAskResponse.APPROVE, primary: true },
				{ label: "Cancel", value: DiracAskResponse.REJECT },
			],
		})
		let response: DiracAskResponse
		try {
			const askResult = await cardHandle.waitForInteraction()
			response = askResult.response
		} catch (error) {
			if (error instanceof ToolSkippedByUserMessage) {
				await cardHandle.finalize(CardStatus.CANCELLED)
				this.deps.taskState.pendingUserMessage = error.userMessage
				this.deps.taskState.pendingUserImages = error.userImages
				this.deps.taskState.pendingUserFiles = error.userFiles
				return false // retry with pending user message
			}
			throw error
		}
		await cardHandle.finalize(response === DiracAskResponse.APPROVE ? CardStatus.SUCCESS : CardStatus.CANCELLED)
		if (response === DiracAskResponse.APPROVE) this.deps.taskState.emptyResponseRetryAttempts = 0
		return response !== DiracAskResponse.APPROVE
	}
}
