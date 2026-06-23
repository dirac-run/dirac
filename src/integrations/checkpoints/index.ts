import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { findLast, findLastIndex } from "@shared/array"
import { HistoryItem } from "@shared/HistoryItem"
import { DiracCheckpointRestore } from "@shared/WebviewMessage"
import { Logger } from "@/shared/services/Logger"
import { MessageStateHandler } from "../../core/task/message-state"
import { TaskMessenger } from "../../core/task/TaskMessenger"
import { TaskState } from "../../core/task/TaskState"
import { CheckpointDiffPresenter } from "./CheckpointDiffPresenter"
import { CheckpointRestoreHandler } from "./CheckpointRestoreHandler"
import { CheckpointStorageManager } from "./CheckpointStorageManager"
import { ICheckpointManager } from "./types"

type UpdateTaskHistoryFunction = (historyItem: HistoryItem) => Promise<HistoryItem[]>

interface CheckpointManagerTask {
	readonly taskId: string
}
interface CheckpointManagerConfig {
	readonly enableCheckpoints: boolean
}
interface CheckpointManagerServices {
	readonly fileContextTracker: FileContextTracker
	readonly diffViewProvider: DiffViewProvider
	readonly messageStateHandler: MessageStateHandler
	readonly taskState: TaskState
	readonly workspaceManager?: WorkspaceRootManager
}
interface CheckpointManagerCallbacks {
	readonly updateTaskHistory: UpdateTaskHistoryFunction
	readonly cancelTask: () => Promise<void>
	readonly taskMessenger: TaskMessenger
	readonly postStateToWebview: () => Promise<void>
	readonly resetTransientState: () => Promise<void>
}
interface CheckpointManagerInternalState {
	conversationHistoryDeletedRange?: [number, number]
	checkpointTracker?: CheckpointTracker
	checkpointManagerErrorMessage?: string
	checkpointTrackerInitPromise?: Promise<CheckpointTracker | undefined>
}
interface CheckpointRestoreStateUpdate {
	conversationHistoryDeletedRange?: [number, number]
	checkpointManagerErrorMessage?: string
}

/**
 * TaskCheckpointManager
 *
 * Main interface between the task and the checkpoint system. Delegates disk-level
 * operations to CheckpointStorageManager, restoration logic to CheckpointRestoreHandler,
 * and diff presentation to CheckpointDiffPresenter.
 */
export class TaskCheckpointManager implements ICheckpointManager {
	private readonly task: CheckpointManagerTask
	private readonly config: CheckpointManagerConfig
	private readonly services: CheckpointManagerServices
	private readonly callbacks: CheckpointManagerCallbacks
	private readonly taskState: TaskState
	private readonly storage: CheckpointStorageManager
	private readonly restoreHandler: CheckpointRestoreHandler
	private readonly diffPresenter: CheckpointDiffPresenter
	private conversationHistoryDeletedRange?: [number, number]

	constructor(
		task: CheckpointManagerTask,
		config: CheckpointManagerConfig,
		services: CheckpointManagerServices,
		callbacks: CheckpointManagerCallbacks,
		initialState: CheckpointManagerInternalState,
	) {
		this.task = Object.freeze(task)
		this.config = config
		this.services = services
		this.callbacks = Object.freeze(callbacks)
		this.taskState = services.taskState
		this.conversationHistoryDeletedRange = initialState.conversationHistoryDeletedRange

		this.storage = new CheckpointStorageManager(
			{ taskId: task.taskId, enableCheckpoints: config.enableCheckpoints },
			{
				messageStateHandler: services.messageStateHandler,
				taskState: services.taskState,
				workspaceManager: services.workspaceManager,
			},
			{ postStateToWebview: callbacks.postStateToWebview },
		)
		if (initialState.checkpointTracker) this.storage.setTracker(initialState.checkpointTracker)
		if (initialState.checkpointManagerErrorMessage)
			this.storage.setCheckpointManagerErrorMessage(initialState.checkpointManagerErrorMessage)

		this.restoreHandler = new CheckpointRestoreHandler(
			{ taskId: task.taskId, enableCheckpoints: config.enableCheckpoints },
			{
				messageStateHandler: services.messageStateHandler,
				fileContextTracker: services.fileContextTracker,
				taskState: services.taskState,
			},
			{
				cancelTask: callbacks.cancelTask,
				resetTransientState: callbacks.resetTransientState,
				taskMessenger: callbacks.taskMessenger,
			},
			this.storage,
			initialState.conversationHistoryDeletedRange,
		)

		this.diffPresenter = new CheckpointDiffPresenter(
			{ taskId: task.taskId, enableCheckpoints: config.enableCheckpoints },
			{ messageStateHandler: services.messageStateHandler },
			this.storage,
		)
	}

	/** Creates a checkpoint of the current workspace state */
	async saveCheckpoint(isAttemptCompletionMessage = false, completionMessageId?: string): Promise<void> {
		try {
			if (
				!this.config.enableCheckpoints ||
				this.storage.getErrorMessage()?.includes("Checkpoints initialization timed out.")
			)
				return

			// Set isCheckpointCheckedOut to false for all messages with checkpoint hashes
			const diracMessages = this.services.messageStateHandler.getDiracMessages()
			diracMessages.forEach((message) => {
				if (message.lastCheckpointHash) message.isCheckpointCheckedOut = false
			})

			// Initialize tracker if needed (non-attempt: only first time; attempt: one last chance)
			if (
				!this.storage.getTracker() &&
				!this.storage.getErrorMessage()?.includes("Checkpoints initialization timed out.")
			) {
				if (!isAttemptCompletionMessage && !this.storage.getErrorMessage()) {
					await this.checkpointTrackerCheckAndInit()
				} else if (isAttemptCompletionMessage) {
					await this.checkpointTrackerCheckAndInit()
				}
			}

			if (!this.storage.getTracker()) {
				Logger.error(
					`[TaskCheckpointManager] Failed to save checkpoint for task ${this.task.taskId}: Checkpoint tracker not available`,
				)
				return
			}

			if (!isAttemptCompletionMessage) {
				// Ensure we aren't creating back-to-back checkpoint_created messages
				if (diracMessages.at(-1)?.content.type === "checkpoint") return

				// Create a new checkpoint message and asynchronously add the commitHash
				const cardHandle = await this.callbacks.taskMessenger.createCheckpoint()
				const targetMessage = this.services.messageStateHandler.getDiracMessages().find((m) => m.id === cardHandle.id)
				if (targetMessage) {
					// Optimization: Background commit
					this.storage
						.getTracker()
						?.commit()
						.then(async (commitHash) => {
							if (commitHash) {
								targetMessage.lastCheckpointHash = commitHash
								await this.services.messageStateHandler.saveDiracMessagesAndUpdateHistory()
							}
						})
						.catch((error) => {
							Logger.error(
								`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.task.taskId}:`,
								error,
							)
						})
				}
			} else {
				// attempt_completion: check last 3 messages for existing completion checkpoint
				const lastFivediracMessages = this.services.messageStateHandler.getDiracMessages().slice(-3)
				const lastCompletionResultMessage = findLast(
					lastFivediracMessages,
					(m) => m.content.type === "card" && m.content.card.header === "Completion Result",
				)
				if (lastCompletionResultMessage?.lastCheckpointHash) {
					Logger.log("Completion checkpoint already exists, skipping duplicate checkpoint creation")
					return
				}

				// Commit then update the completion_result message with the checkpoint hash
				const commitHash = await this.storage.getTracker()?.commit()
				if (completionMessageId) {
					const targetMessage = this.services.messageStateHandler
						.getDiracMessages()
						.find((m) => m.id === completionMessageId)
					if (targetMessage) {
						targetMessage.lastCheckpointHash = commitHash
						await this.services.messageStateHandler.saveDiracMessagesAndUpdateHistory()
					}
				} else if (lastCompletionResultMessage) {
					lastCompletionResultMessage.lastCheckpointHash = commitHash
					await this.services.messageStateHandler.saveDiracMessagesAndUpdateHistory()
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[TaskCheckpointManager] Failed to save checkpoint for task ${this.task.taskId}:`, errorMessage)
		}
	}

	/** Restores a checkpoint by message ID */
	async restoreCheckpoint(
		messageId: string,
		restoreType: DiracCheckpointRestore,
		offset?: number,
	): Promise<CheckpointRestoreStateUpdate> {
		const result = await this.restoreHandler.restoreCheckpoint(messageId, restoreType, offset)
		this.conversationHistoryDeletedRange = this.restoreHandler.getConversationHistoryDeletedRange()
		return result
	}

	/** Presents a multi-file diff view between checkpoints */
	async presentMultifileDiff(messageId: string, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void> {
		await this.diffPresenter.presentMultifileDiff(messageId, seeNewChangesSinceLastTaskCompletion)
	}

	/** Creates a checkpoint commit in the underlying tracker */
	async commit(): Promise<string | undefined> {
		return await this.storage.commit()
	}

	/** Checks if the latest task completion has new changes */
	async doesLatestTaskCompletionHaveNewChanges(): Promise<boolean> {
		try {
			if (!this.config.enableCheckpoints) return false

			const diracMessages = this.services.messageStateHandler.getDiracMessages()
			const messageIndex = findLastIndex(
				diracMessages,
				(m) => m.content.type === "card" && m.content.card.header === "Completion Result",
			)
			const message = diracMessages[messageIndex]
			if (!message) {
				Logger.error(`[TaskCheckpointManager] Completion message not found for task ${this.task.taskId}`)
				return false
			}
			const hash = message.lastCheckpointHash
			if (!hash) {
				Logger.error(
					`[TaskCheckpointManager] No checkpoint hash found for completion message in task ${this.task.taskId}`,
				)
				return false
			}

			// Initialize tracker if needed
			if (!this.storage.getTracker() && !this.storage.getErrorMessage()) {
				try {
					const workspacePath = await this.storage.getWorkspacePath()
					const tracker = await CheckpointTracker.create(this.task.taskId, this.config.enableCheckpoints, workspacePath)
					this.storage.setTracker(tracker)
					this.services.messageStateHandler.setCheckpointTracker(tracker)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					Logger.error(
						`[TaskCheckpointManager] Failed to initialize checkpoint tracker for task ${this.task.taskId}:`,
						errorMessage,
					)
					await this.storage.setCheckpointManagerErrorMessage(errorMessage)
					return false
				}
			}

			if (!this.storage.getTracker()) {
				Logger.error(`[TaskCheckpointManager] Checkpoint tracker not available for task ${this.task.taskId}`)
				return false
			}

			// Find previous checkpoint hash (last completion or first checkpoint)
			const lastTaskCompletedMessageCheckpointHash = findLast(
				this.services.messageStateHandler.getDiracMessages().slice(0, messageIndex),
				(m) => m.content.type === "card" && m.content.card.header === "Completion Result",
			)?.lastCheckpointHash
			const firstCheckpointMessageCheckpointHash = this.services.messageStateHandler
				.getDiracMessages()
				.find((m) => m.content.type === "checkpoint")?.lastCheckpointHash
			const previousCheckpointHash = lastTaskCompletedMessageCheckpointHash || firstCheckpointMessageCheckpointHash

			if (!previousCheckpointHash) {
				Logger.error(`[TaskCheckpointManager] No previous checkpoint hash found for task ${this.task.taskId}`)
				return false
			}

			const changedFilesCount = (await this.storage.getTracker()?.getDiffCount(previousCheckpointHash, hash)) || 0
			return changedFilesCount > 0
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			Logger.error(`[TaskCheckpointManager] Failed to check for new changes in task ${this.task.taskId}:`, errorMessage)
			return false
		}
	}

	// --- State management delegation ---

	/** Checks for an active checkpoint tracker instance, creates if needed */
	async checkpointTrackerCheckAndInit(): Promise<CheckpointTracker | undefined> {
		return await this.storage.checkpointTrackerCheckAndInit()
	}

	/** Updates the checkpoint tracker instance */
	setCheckpointTracker(checkpointTracker: CheckpointTracker | undefined): void {
		this.storage.setTracker(checkpointTracker)
	}

	/** Updates the checkpoint tracker error message and posts to webview */
	async setcheckpointManagerErrorMessage(errorMessage: string | undefined): Promise<void> {
		await this.storage.setCheckpointManagerErrorMessage(errorMessage)
	}

	/** Updates the conversation history deleted range */
	updateConversationHistoryDeletedRange(range: [number, number] | undefined): void {
		this.conversationHistoryDeletedRange = range
	}

	/** Provides public read-only access to current state */
	public getCurrentState(): Readonly<CheckpointManagerInternalState> {
		return Object.freeze({
			conversationHistoryDeletedRange: this.conversationHistoryDeletedRange,
			checkpointTracker: this.storage.getTracker(),
			checkpointManagerErrorMessage: this.storage.getErrorMessage(),
			checkpointTrackerInitPromise: this.storage.getInitPromise(),
		})
	}
}

/** Creates a new TaskCheckpointManager instance */
export function createTaskCheckpointManager(
	task: CheckpointManagerTask,
	config: CheckpointManagerConfig,
	services: CheckpointManagerServices,
	callbacks: CheckpointManagerCallbacks,
	initialState: CheckpointManagerInternalState,
): TaskCheckpointManager {
	return new TaskCheckpointManager(task, config, services, callbacks, initialState)
}
