import { sendRelinquishControlEvent } from "@core/controller/ui/subscribeToRelinquishControl"
import { findLast } from "@shared/array"
import { isTaskCompletionCard } from "@shared/cardIdentity"
import { HostProvider } from "@/hosts/host-provider"
import { getErrorMessage } from "@/shared/errors"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { MessageStateHandler } from "../task/message-state"
import type { CreateCheckpointTracker } from "./CheckpointRestoreHandler"
import type { CheckpointStorageManager } from "./CheckpointStorageManager"

interface CheckpointDiffConfig {
	enableCheckpoints: boolean
	readonly taskId: string
}
interface CheckpointDiffServices {
	readonly messageStateHandler: MessageStateHandler
	readonly createCheckpointTracker: CreateCheckpointTracker
}

/**
 * CheckpointDiffPresenter
 *
 * Presents multi-file diff views between checkpoints using the host's diff UI.
 * Resolves the previous and current checkpoint hashes, fetches the diff set
 * from the tracker, and opens the multi-file diff editor.
 */
export class CheckpointDiffPresenter {
	private readonly config: CheckpointDiffConfig
	private readonly services: CheckpointDiffServices
	private readonly storage: CheckpointStorageManager

	constructor(config: CheckpointDiffConfig, services: CheckpointDiffServices, storage: CheckpointStorageManager) {
		this.config = config
		this.services = services
		this.storage = storage
	}

	setEnabled(enabled: boolean): void {
		this.config.enableCheckpoints = enabled
	}

	/**
	 * Presents a multi-file diff view between checkpoints
	 * @param messageId - ID of the message to show diff for
	 * @param seeNewChangesSinceLastTaskCompletion - Whether to show changes since last completion
	 */
	async presentMultifileDiff(messageId: string, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void> {
		const relinquishButton = () => {
			sendRelinquishControlEvent()
		}

		try {
			if (!this.config.enableCheckpoints) {
				const errorMessage = "Checkpoints are disabled in settings. Cannot show diff."
				Logger.error(`[CheckpointDiffPresenter] ${errorMessage} for task ${this.config.taskId}`)
				HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: errorMessage })
				relinquishButton()
				return
			}

			Logger.log(`[CheckpointDiffPresenter] presentMultifileDiff for task ${this.config.taskId}, messageId: ${messageId}`)
			const diracMessages = this.services.messageStateHandler.getDiracMessages()
			const messageIndex = diracMessages.findIndex((m) => m.id === messageId)
			const message = diracMessages[messageIndex]
			if (!message) {
				Logger.error(`[CheckpointDiffPresenter] Message not found for id ${messageId} in task ${this.config.taskId}`)
				relinquishButton()
				return
			}
			const hash = message.lastCheckpointHash
			if (!hash) {
				Logger.error(
					`[CheckpointDiffPresenter] No checkpoint hash found for message ${messageId} in task ${this.config.taskId}`,
				)
				relinquishButton()
				return
			}

			// Initialize checkpoint tracker if needed
			if (!this.storage.getTracker() && this.config.enableCheckpoints && !this.storage.getErrorMessage()) {
				try {
					const workspacePath = await this.storage.getWorkspacePath()
					const tracker = await this.services.createCheckpointTracker(
						this.config.taskId,
						this.config.enableCheckpoints,
						workspacePath,
					)
					this.storage.setTracker(tracker)
					this.services.messageStateHandler.setCheckpointTracker(tracker)
				} catch (error) {
					const errorMessage = getErrorMessage(error, "Unknown error")
					Logger.error(
						`[CheckpointDiffPresenter] Failed to initialize checkpoint tracker for task ${this.config.taskId}:`,
						errorMessage,
					)
					this.storage.setCheckpointManagerErrorMessage(errorMessage)
					HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
					relinquishButton()
					return
				}
			}

			if (!this.storage.getTracker()) {
				Logger.error(`[CheckpointDiffPresenter] Checkpoint tracker not available for task ${this.config.taskId}`)
				HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Checkpoint tracker not available" })
				relinquishButton()
				return
			}

			let changedFiles: { relativePath: string; absolutePath: string; before: string; after: string }[] | undefined

			if (seeNewChangesSinceLastTaskCompletion) {
				// Get last task completed
				const lastTaskCompletedMessageCheckpointHash = findLast(
					this.services.messageStateHandler.getDiracMessages().slice(0, messageIndex),
					(m) => m.content.type === "card" && isTaskCompletionCard(m.content.card),
				)?.lastCheckpointHash

				// This value *should* always exist
				const firstCheckpointMessageCheckpointHash = this.services.messageStateHandler
					.getDiracMessages()
					.find((m) => m.content.type === "checkpoint")?.lastCheckpointHash

				const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash

				if (!previousCheckpointHash) {
					const errorMessage = "Unexpected error: No checkpoint hash found"
					Logger.error(`[CheckpointDiffPresenter] ${errorMessage} for task ${this.config.taskId}`)
					HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
					relinquishButton()
					return
				}

				// Get changed files between current state and commit
				changedFiles = await this.storage.getTracker()?.getDiffSet(previousCheckpointHash, hash)
				if (!changedFiles?.length) {
					HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: "No changes found" })
					relinquishButton()
					return
				}
			} else {
				// Get changed files between current state and commit
				changedFiles = await this.storage.getTracker()?.getDiffSet(hash)
				if (!changedFiles?.length) {
					HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: "No changes found" })
					relinquishButton()
					return
				}
			}

			// Open multi-diff editor
			const title = seeNewChangesSinceLastTaskCompletion ? "New changes" : "Changes since snapshot"
			const diffs = changedFiles.map((file) => ({
				filePath: file.absolutePath,
				leftContent: file.before,
				rightContent: file.after,
			}))
			await HostProvider.diff.openMultiFileDiff({ title, diffs })

			relinquishButton()
		} catch (error) {
			const errorMessage = getErrorMessage(error, "Unknown error")
			Logger.error(
				`[CheckpointDiffPresenter] Failed to present multifile diff for task ${this.config.taskId}:`,
				errorMessage,
			)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to retrieve diff set: ${errorMessage}`,
			})
			relinquishButton()
		}
	}
}
