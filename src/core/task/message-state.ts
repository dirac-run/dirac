import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { EventEmitter } from "events"
import getFolderSize from "get-folder-size"
import Mutex from "p-mutex"
import { findLastIndex } from "@/shared/array"
import { combineCardSequences } from "@/shared/combineCardSequences"
import { DiracMessage } from "@/shared/ExtensionMessage"
import { getApiMetrics } from "@/shared/getApiMetrics"
import { HistoryItem } from "@/shared/HistoryItem"
import { DiracStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import { ensureTaskDirectoryExists, saveApiConversationHistory, saveDiracMessages } from "../storage/disk"
import { TaskState } from "./TaskState"

// Event types for diracMessages changes
export type DiracMessageChangeType = "add" | "update" | "delete" | "set"

export interface DiracMessageChange {
	type: DiracMessageChangeType
	/** The full array after the change */
	messages: DiracMessage[]
	/** The affected index (for add/update/delete) */
	index?: number
	/** The new/updated message (for add/update) */
	message?: DiracMessage
	/** The old message before change (for update/delete) */
	previousMessage?: DiracMessage
	/** The entire previous array (for set) */
	previousMessages?: DiracMessage[]
}

// Strongly-typed event emitter interface
export interface MessageStateHandlerEvents {
	diracMessagesChanged: [change: DiracMessageChange]
}

interface MessageStateHandlerParams {
	taskId: string
	ulid: string
	taskIsFavorited?: boolean
	workspaceRootPath?: string
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	taskState: TaskState
	checkpointManagerErrorMessage?: string
}

export class MessageStateHandler extends EventEmitter<MessageStateHandlerEvents> {
	private workspaceRootPath?: string
	private apiConversationHistory: DiracStorageMessage[] = []
	private diracMessages: DiracMessage[] = []
	private taskIsFavorited: boolean
	private checkpointTracker: CheckpointTracker | undefined
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private taskId: string
	private ulid: string
	private taskState: TaskState

	// Mutex to prevent concurrent state modifications (RC-4)
	// Protects against data loss from race conditions when multiple
	// operations try to modify message state simultaneously
	// This follows the same pattern as Task.stateMutex for consistency
	private stateMutex = new Mutex()

	constructor(params: MessageStateHandlerParams) {
		super()
		this.taskId = params.taskId
		this.ulid = params.ulid
		this.taskState = params.taskState
		this.taskIsFavorited = params.taskIsFavorited ?? false
		this.workspaceRootPath = params.workspaceRootPath
		this.updateTaskHistory = params.updateTaskHistory
	}

	/**
	 * Emit a diracMessagesChanged event with the change details
	 */
	private emitDiracMessagesChanged(change: DiracMessageChange): void {
		this.emit("diracMessagesChanged", change)
	}

	setCheckpointTracker(tracker: CheckpointTracker | undefined) {
		this.checkpointTracker = tracker
	}

	/**
	 * Execute function with exclusive lock on message state
	 * Use this for ANY state modification to prevent race conditions
	 * This follows the same pattern as Task.withStateLock for consistency
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	getApiConversationHistory(): DiracStorageMessage[] {
		return this.apiConversationHistory
	}

	setApiConversationHistory(newHistory: DiracStorageMessage[]): void {
		this.apiConversationHistory = newHistory
	}

	getDiracMessages(): DiracMessage[] {
		return this.diracMessages
	}

	setDiracMessages(newMessages: DiracMessage[]) {
		const previousMessages = this.diracMessages
		this.diracMessages = newMessages
		this.emitDiracMessagesChanged({
			type: "set",
			messages: this.diracMessages,
			previousMessages,
		})
	}

	/**
	 * Internal method to save messages and update history (without mutex protection)
	 * This is used by methods that already hold the stateMutex lock
	 * Should NOT be called directly - use saveDiracMessagesAndUpdateHistory() instead
	 */
	/**
	 * Internal method to save messages (without mutex protection)
	 */
	private async saveDiracMessagesInternal(): Promise<void> {
		try {
			await saveDiracMessages(this.taskId, this.diracMessages)
		} catch (error) {
			Logger.error("Failed to save dirac messages:", error)
		}
	}

	/**
	 * Update task history with current state.
	 * This can be slow due to folder size calculation, so it should be called
	 * outside of the stateMutex lock when possible.
	 */
	private async updateTaskHistoryInternal(): Promise<void> {
		try {
			// Capture state needed for history update
			// Note: we don't hold the lock here, but these are mostly immutable or
			// fine to have slight inconsistencies in the history summary.
			const messages = [...this.diracMessages]
			if (messages.length === 0) return

			const apiMetrics = getApiMetrics(combineCardSequences(messages.slice(1)))
			const taskMessage = messages[0]
			const lastRelevantMessage =
				messages[
					findLastIndex(
						messages,
						(message) =>
							!(
								message.content.type === "card" &&
								(message.content.card.header.includes("Resume") || message.content.card.header.includes("Task Resumed"))
							),
					)

				] || messages[messages.length - 1]

			const lastModelInfo = [...this.apiConversationHistory].reverse().find((msg) => msg.modelInfo !== undefined)
			const taskDir = await ensureTaskDirectoryExists(this.taskId)
			
			// Slow operation: get folder size
			let taskDirSize = 0
			try {
				taskDirSize = await getFolderSize.loose(taskDir)
			} catch (error) {
				Logger.error("Failed to get task directory size:", taskDir, error)
			}

			const cwd = await getCwd(getDesktopDir())
			const shadowGitConfigWorkTree = await this.checkpointTracker?.getShadowGitConfigWorkTree()

			await this.updateTaskHistory({
				id: this.taskId,
				ulid: this.ulid,
				ts: lastRelevantMessage.ts,
				task: taskMessage.content.type === "markdown" ? taskMessage.content.content : "",
				tokensIn: apiMetrics.totalTokensIn,
				tokensOut: apiMetrics.totalTokensOut,
				cacheWrites: apiMetrics.totalCacheWrites,
				cacheReads: apiMetrics.totalCacheReads,
				totalCost: apiMetrics.totalCost,
				size: taskDirSize,
				shadowGitConfigWorkTree,
				cwdOnTaskInitialization: cwd,
				conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
				isFavorited: this.taskIsFavorited,
				workspaceRootPath: this.workspaceRootPath,
				checkpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
				modelId: lastModelInfo?.modelInfo?.modelId,
			})
		} catch (error) {
			Logger.error("Failed to update task history:", error)
		}
	}

	/**
	 * Save dirac messages and update task history (public API with mutex protection)
	 * This is the main entry point for saving message state from external callers
	 */
	async saveDiracMessagesAndUpdateHistory(): Promise<void> {
		await this.withStateLock(async () => {
			await this.saveDiracMessagesInternal()
		})
		await this.updateTaskHistoryInternal()
	}

	async addToApiConversationHistory(message: DiracStorageMessage) {
		// Protect with mutex to prevent concurrent modifications from corrupting data (RC-4)
		return await this.withStateLock(async () => {
			this.apiConversationHistory.push(message)
			await saveApiConversationHistory(this.taskId, this.apiConversationHistory)
		})
	}

	async overwriteApiConversationHistory(newHistory: DiracStorageMessage[]): Promise<void> {
		// Protect with mutex to prevent concurrent modifications from corrupting data (RC-4)
		return await this.withStateLock(async () => {
			this.apiConversationHistory = newHistory
			await saveApiConversationHistory(this.taskId, this.apiConversationHistory)
		})
	}

	/**
	 * Add a new message to diracMessages array with proper index tracking
	 * CRITICAL: This entire operation must be atomic to prevent race conditions (RC-4)
	 * The conversationHistoryIndex must be set correctly based on the current state,
	 * and the message must be added and saved without any interleaving operations
	 */
	async addToDiracMessages(message: DiracMessage) {
		await this.withStateLock(async () => {
			// these values allow us to reconstruct the conversation history at the time this dirac message was created
			// it's important that apiConversationHistory is initialized before we add dirac messages
			message.conversationHistoryIndex = this.apiConversationHistory.length - 1
			message.conversationHistoryDeletedRange = this.taskState.conversationHistoryDeletedRange
			const index = this.diracMessages.length
			this.diracMessages.push(message)
			this.emitDiracMessagesChanged({
				type: "add",
				messages: this.diracMessages,
				index,
				message,
			})
			await this.saveDiracMessagesInternal()
		})
		await this.updateTaskHistoryInternal()
	}

	/**
	 * Replace the entire diracMessages array with new messages
	 * Protected by mutex to prevent concurrent modifications (RC-4)
	 */
	async overwriteDiracMessages(newMessages: DiracMessage[]) {
		await this.withStateLock(async () => {
			const previousMessages = this.diracMessages
			this.diracMessages = newMessages
			this.emitDiracMessagesChanged({
				type: "set",
				messages: this.diracMessages,
				previousMessages,
			})
			await this.saveDiracMessagesInternal()
		})
		await this.updateTaskHistoryInternal()
	}

	/**
	 * Find the index of a message by its ID
	 */
	findMessageIndexById(id: string): number {
		return this.diracMessages.findIndex((m) => m.id === id)
	}

	/**
	 * Find the index of a message containing a card with the specified ID
	 */
	findMessageIndexByCardId(cardId: string): number {
		return this.diracMessages.findIndex((m) => m.content.type === "card" && m.content.card.id === cardId)
	}
	/**
	 * Update a specific message in the diracMessages array
	 * The entire operation (validate, update, save) is atomic to prevent races (RC-4)
	 */
	async updateDiracMessage(index: number, updates: Partial<DiracMessage>): Promise<void> {
		await this.withStateLock(async () => {
			if (index < 0 || index >= this.diracMessages.length) {
				throw new Error(`Invalid message index: ${index}`)
			}

			// Capture previous state before mutation
			const previousMessage = { ...this.diracMessages[index] }

			// Apply updates to the message
			Object.assign(this.diracMessages[index], updates)

			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				previousMessage,
				message: this.diracMessages[index],
			})

			// Save changes
			await this.saveDiracMessagesInternal()
		})
		// History update can happen outside the lock and doesn't need to be awaited
		// if we want maximum performance, but for now we await it to be safe.
		// The key is that getFolderSize is now outside the stateMutex lock.
		await this.updateTaskHistoryInternal()
	}

	/**
	 * Delete a specific message from the diracMessages array
	 * The entire operation (validate, delete, save) is atomic to prevent races (RC-4)
	 */
	async deleteDiracMessage(index: number): Promise<void> {
		await this.withStateLock(async () => {
			if (index < 0 || index >= this.diracMessages.length) {
				throw new Error(`Invalid message index: ${index}`)
			}

			// Capture the message before deletion
			const previousMessage = this.diracMessages[index]

			// Remove the message at the specified index
			this.diracMessages.splice(index, 1)

			this.emitDiracMessagesChanged({
				type: "delete",
				messages: this.diracMessages,
				index,
				previousMessage,
			})

			// Save changes
			await this.saveDiracMessagesInternal()
		})
		await this.updateTaskHistoryInternal()
	}
}
