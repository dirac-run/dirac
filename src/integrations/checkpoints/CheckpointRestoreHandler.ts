import { sendRelinquishControlEvent } from "@core/controller/ui/subscribeToRelinquishControl"
import { findLastIndex } from "@shared/array"
import { combineCardSequences } from "@shared/combineCardSequences"
import { DiracMessage } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { DiracCheckpointRestore } from "@shared/WebviewMessage"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { FileContextTracker } from "../../core/context/context-tracking/FileContextTracker"
import { MessageStateHandler } from "../../core/task/message-state"
import { TaskMessenger } from "../../core/task/TaskMessenger"
import { TaskState } from "../../core/task/TaskState"
import type { CheckpointStorageManager } from "./CheckpointStorageManager"

interface CheckpointRestoreConfig {
	readonly enableCheckpoints: boolean
	readonly taskId: string
}
interface CheckpointRestoreServices {
	readonly messageStateHandler: MessageStateHandler
	readonly fileContextTracker: FileContextTracker
	readonly taskState: TaskState
}
interface CheckpointRestoreCallbacks {
	readonly cancelTask: () => Promise<void>
	readonly resetTransientState: () => Promise<void>
	readonly taskMessenger: TaskMessenger
}

export interface CheckpointRestoreResult {
	conversationHistoryDeletedRange?: [number, number]
	checkpointManagerErrorMessage?: string
}

/**
 * CheckpointRestoreHandler
 *
 * Handles checkpoint restoration logic: resetting workspace state via git,
 * truncating conversation history, aggregating deleted API metrics, and
 * coordinating the post-restore cleanup (cancel task, reset transient state).
 */
export class CheckpointRestoreHandler {
	private readonly config: CheckpointRestoreConfig
	private readonly services: CheckpointRestoreServices
	private readonly callbacks: CheckpointRestoreCallbacks
	private readonly storage: CheckpointStorageManager

	private conversationHistoryDeletedRange?: [number, number]

	constructor(
		config: CheckpointRestoreConfig,
		services: CheckpointRestoreServices,
		callbacks: CheckpointRestoreCallbacks,
		storage: CheckpointStorageManager,
		initialConversationHistoryDeletedRange?: [number, number],
	) {
		this.config = config
		this.services = services
		this.callbacks = callbacks
		this.storage = storage
		this.conversationHistoryDeletedRange = initialConversationHistoryDeletedRange
	}

	getConversationHistoryDeletedRange(): [number, number] | undefined {
		return this.conversationHistoryDeletedRange
	}

	/**
	 * Restores a checkpoint by message ID
	 */
	async restoreCheckpoint(
		messageId: string,
		restoreType: DiracCheckpointRestore,
		offset?: number,
	): Promise<CheckpointRestoreResult> {
		try {
			const diracMessages = this.services.messageStateHandler.getDiracMessages()
			const messageIndex = diracMessages.findIndex((m) => m.id === messageId) - (offset || 0)
			const lastHashIndex = findLastIndex(diracMessages.slice(0, messageIndex), (m) => m.lastCheckpointHash !== undefined)
			const message = diracMessages[messageIndex]
			const lastMessageWithHash = diracMessages[lastHashIndex]

			if (!message) {
				Logger.error(`[CheckpointRestoreHandler] Message not found for id ${messageId} in task ${this.config.taskId}`)
				return {}
			}

			let didWorkspaceRestoreFail = false

			switch (restoreType) {
				case "task":
					break
				case "taskAndWorkspace":
				case "workspace":
					if (!this.config.enableCheckpoints) {
						const errorMessage = "Checkpoints are disabled in settings."
						Logger.error(`[CheckpointRestoreHandler] ${errorMessage} for task ${this.config.taskId}`)
						HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
						didWorkspaceRestoreFail = true
						break
					}

					if (!this.storage.getTracker() && !this.storage.getErrorMessage()) {
						try {
							const workspacePath = await this.storage.getWorkspacePath()
							const tracker = await import("@integrations/checkpoints/CheckpointTracker").then((m) =>
								m.default.create(this.config.taskId, this.config.enableCheckpoints, workspacePath),
							)
							this.storage.setTracker(tracker)
							this.services.messageStateHandler.setCheckpointTracker(tracker)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							Logger.error(
								`[CheckpointRestoreHandler] Failed to initialize checkpoint tracker for task ${this.config.taskId}:`,
								errorMessage,
							)
							await this.storage.setCheckpointManagerErrorMessage(errorMessage)
							HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
							didWorkspaceRestoreFail = true
						}
					}

					if (message.lastCheckpointHash && this.storage.getTracker()) {
						try {
							await this.storage.getTracker()?.resetHead(message.lastCheckpointHash)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							Logger.error(
								`[CheckpointRestoreHandler] Failed to restore checkpoint for task ${this.config.taskId}:`,
								errorMessage,
							)
							HostProvider.window.showMessage({
								type: ShowMessageType.ERROR,
								message: `Failed to restore checkpoint: ${errorMessage}`,
							})
							didWorkspaceRestoreFail = true
						}
					} else if (offset && lastMessageWithHash?.lastCheckpointHash && this.storage.getTracker()) {
						try {
							await this.storage.getTracker()?.resetHead(lastMessageWithHash.lastCheckpointHash)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							Logger.error(
								`[CheckpointRestoreHandler] Failed to restore offset checkpoint for task ${this.config.taskId}:`,
								errorMessage,
							)
							HostProvider.window.showMessage({
								type: ShowMessageType.ERROR,
								message: `Failed to restore offset checkpoint: ${errorMessage}`,
							})
							didWorkspaceRestoreFail = true
						}
					} else if (!offset && lastMessageWithHash?.lastCheckpointHash && this.storage.getTracker()) {
						// Fallback: restore to most recent checkpoint when target message has no checkpoint hash
						Logger.warn(
							`[CheckpointRestoreHandler] Message ${messageId} has no checkpoint hash, falling back to previous checkpoint for task ${this.config.taskId}`,
						)
						try {
							await this.storage.getTracker()?.resetHead(lastMessageWithHash.lastCheckpointHash)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : "Unknown error"
							Logger.error(
								`[CheckpointRestoreHandler] Failed to restore fallback checkpoint for task ${this.config.taskId}:`,
								errorMessage,
							)
							HostProvider.window.showMessage({
								type: ShowMessageType.ERROR,
								message: `Failed to restore checkpoint: ${errorMessage}`,
							})
							didWorkspaceRestoreFail = true
						}
					} else {
						// Distinguish missing hash from missing tracker so users chase the right cause
						const hasHash = !!(message.lastCheckpointHash || lastMessageWithHash?.lastCheckpointHash)
						const errorMessage = hasHash
							? "Failed to restore checkpoint: checkpoint tracker not available"
							: "Failed to restore checkpoint: No valid checkpoint hash found"
						Logger.error(`[CheckpointRestoreHandler] ${errorMessage} for task ${this.config.taskId}`)
						HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
						didWorkspaceRestoreFail = true
					}
					break
			}

			const checkpointManagerStateUpdate: CheckpointRestoreResult = {}

			if (!didWorkspaceRestoreFail) {
				await this.handleSuccessfulRestore(restoreType, message, messageIndex, messageId)
				if (this.conversationHistoryDeletedRange !== undefined) {
					checkpointManagerStateUpdate.conversationHistoryDeletedRange = this.conversationHistoryDeletedRange
				}
			} else {
				sendRelinquishControlEvent()
				if (this.storage.getErrorMessage() !== undefined) {
					checkpointManagerStateUpdate.checkpointManagerErrorMessage = this.storage.getErrorMessage()
				}
			}

			return checkpointManagerStateUpdate
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[CheckpointRestoreHandler] Failed to restore checkpoint for task ${this.config.taskId}:`, errorMessage)
			sendRelinquishControlEvent()
			return { checkpointManagerErrorMessage: errorMessage }
		}
	}

	/**
	 * Handles the successful restoration logic for different restore types
	 */
	private async handleSuccessfulRestore(
		restoreType: DiracCheckpointRestore,
		message: DiracMessage,
		messageIndex: number,
		messageId: string,
	): Promise<void> {
		switch (restoreType) {
			case "task":
			case "taskAndWorkspace":
				// Update conversation history deleted range in our state
				this.conversationHistoryDeletedRange = message.conversationHistoryDeletedRange
				this.services.taskState.conversationHistoryDeletedRange = message.conversationHistoryDeletedRange

				const apiConversationHistory = this.services.messageStateHandler.getApiConversationHistory()
				const newConversationHistory = apiConversationHistory.slice(0, (message.conversationHistoryIndex || 0) + 2)
				await this.services.messageStateHandler.overwriteApiConversationHistory(newConversationHistory)

				// aggregate deleted api reqs info so we don't lose costs/tokens
				const diracMessages = this.services.messageStateHandler.getDiracMessages()
				const deletedMessages = diracMessages.slice(messageIndex + 1)
				const deletedApiReqsMetrics = getApiMetrics(combineCardSequences(deletedMessages))

				// Detect files edited after this message timestamp for file context warning
				if (restoreType === "task") {
					const filesEditedAfterMessage = await this.services.fileContextTracker.detectFilesEditedAfterMessage(
						message.ts,
						deletedMessages,
					)
					if (filesEditedAfterMessage.length > 0) {
						await this.services.fileContextTracker.storePendingFileContextWarning(filesEditedAfterMessage)
					}
				}

				const newDiracMessages = diracMessages.slice(0, messageIndex + 1)
				await this.services.messageStateHandler.overwriteDiracMessages(newDiracMessages)

				await this.callbacks.taskMessenger.upsertApiStatus({
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					cost: deletedApiReqsMetrics.totalCost,
					deletedMetrics: {
						tokensIn: deletedApiReqsMetrics.totalTokensIn,
						tokensOut: deletedApiReqsMetrics.totalTokensOut,
						cacheWrites: deletedApiReqsMetrics.totalCacheWrites,
						cacheReads: deletedApiReqsMetrics.totalCacheReads,
					},
				})
				break
			case "workspace":
				break
		}

		switch (restoreType) {
			case "task":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Task messages have been restored to the checkpoint",
				})
				break
			case "workspace":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Workspace files have been restored to the checkpoint",
				})
				break
			case "taskAndWorkspace":
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Task and workspace have been restored to the checkpoint",
				})
				break
		}

		if (restoreType !== "task") {
			// Set isCheckpointCheckedOut flag on the message
			const checkpointMessages = this.services.messageStateHandler.getDiracMessages().filter((m) => m.lastCheckpointHash)
			const currentMessageIndex = checkpointMessages.findIndex((m) => m.id === messageId)
			checkpointMessages.forEach((m, i) => {
				m.isCheckpointCheckedOut = i === currentMessageIndex
			})
		}

		await this.services.messageStateHandler.saveDiracMessagesAndUpdateHistory()
		// Cancel and reinitialize the task to get updated messages
		await this.callbacks.cancelTask()
		// Reset transient state after successful restore
		await this.callbacks.resetTransientState()
	}
}
