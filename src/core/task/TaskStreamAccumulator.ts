import { formatResponse } from "@core/formatResponse"
import { ICheckpointManager } from "@integrations/checkpoints/types"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { TaskStatus } from "@shared/ExtensionMessage"
import { DiracContent } from "@shared/messages/content"
import { DiracMessageModelInfo } from "@shared/messages/metrics"
import { isMutatingTool } from "@shared/tools"
import pWaitFor from "p-wait-for"
import { StreamingMetricsManager } from "./StreamingMetricsManager"
import { TaskState } from "./TaskState"

// Accumulates stream chunks after a response — handles user input waiting, checkpoint saving, and recursion.
// Extracted from Task to reduce the 1956-line class.
export class TaskStreamAccumulator {
	constructor(
		private taskState: TaskState,
		private checkpointManager: ICheckpointManager | undefined,
		private postStateToWebview: () => Promise<void>,
		private recursivelyMakeDiracRequests: (userContent: DiracContent[], includeFileDetails?: boolean) => Promise<boolean>,
		private handleEmptyAssistantResponse: (params: {
			modelInfo: DiracMessageModelInfo
			taskMetrics: any
			providerId: string
			model: { id: string }
		}) => Promise<boolean | undefined>,
	) {}

	async accumulateStreamChunks(params: {
		assistantHasContent: boolean
		stopReason?: string
		userContent: DiracContent[]
		metricsManager: StreamingMetricsManager
		modelInfo: DiracMessageModelInfo
		providerId: string
		model: { id: string }
	}): Promise<boolean> {
		if (params.assistantHasContent) {
			this.taskState.status = TaskStatus.AWAITING_USER_INPUT
			await pWaitFor(() => this.taskState.userMessageContentReady)

			const hasMutatingTools = this.taskState.assistantMessageContent.some(
				(block) => block.type === "tool_use" && isMutatingTool(block.name),
			)
			if (hasMutatingTools) await this.checkpointManager?.saveCheckpoint()

			const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")
			if (this.taskState.didAttemptCompletion) {
				this.taskState.status = TaskStatus.COMPLETED
				await this.postStateToWebview()
				return true
			}

			const hitTokenLimit =
				params.stopReason === "MAX_TOKENS" || params.stopReason === "max_tokens" || params.stopReason === "length"
			if (!didToolUse) {
				this.taskState.userMessageContent.push({
					type: "text",
					text: hitTokenLimit
						? "You have reached the output token limit. Please continue your response from where you left off. If you were in the middle of a tool call, start over with that tool call. If you were finished, call attempt_completion."
						: formatResponse.noToolsUsed(this.taskState.useNativeToolCalls),
				})
				this.taskState.consecutiveMistakeCount++
			}

			this.taskState.apiErrorRetryAttempts = 0
			this.taskState.emptyResponseRetryAttempts = 0

			if (this.taskState.pendingUserMessage) {
				this.taskState.userMessageContent.push({ type: "text", text: this.taskState.pendingUserMessage })
				if (this.taskState.pendingUserImages?.length) {
					this.taskState.userMessageContent.push(...formatResponse.imageBlocks(this.taskState.pendingUserImages))
				}
				if (this.taskState.pendingUserFiles?.length) {
					const fileContent = await processFilesIntoText(this.taskState.pendingUserFiles)
					if (fileContent) this.taskState.userMessageContent.push({ type: "text", text: fileContent })
				}
				this.taskState.pendingUserMessage = undefined
				this.taskState.pendingUserImages = undefined
				this.taskState.pendingUserFiles = undefined
			}

			return await this.recursivelyMakeDiracRequests(this.taskState.userMessageContent)
		}
		const taskMetrics = params.metricsManager.getMetrics()
		const shouldRetry = await this.handleEmptyAssistantResponse({
			modelInfo: params.modelInfo,
			taskMetrics,
			providerId: params.providerId,
			model: params.model,
		})
		if (shouldRetry === false) {
			this.taskState.consecutiveMistakeCount = 0
			return await this.recursivelyMakeDiracRequests(params.userContent)
		}
		return true
	}
}
