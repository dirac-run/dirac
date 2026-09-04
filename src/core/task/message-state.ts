import type { ApiConversationProviderState } from "@core/api/conversation"
import CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { EventEmitter } from "events"
import getFolderSize from "get-folder-size"
import Mutex from "p-mutex"
import { Card, DiracApiReqInfo, DiracMessage, DiracMessageType } from "@/shared/ExtensionMessage"
import { getApiMetrics } from "@/shared/getApiMetrics"
import { HistoryItem } from "@/shared/HistoryItem"
import {
	DiracStorageMessage,
	DiracUserContent,
	removeUserInputMarkersFromContent,
	removeUserInputMarkersFromMessage,
} from "@/shared/messages/content"
import type { PresentationOperation } from "@/shared/PresentationOperation"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import type { ApiConversationOperation } from "../storage/conversationHistory"
import {
	appendApiConversationOperations,
	appendPresentationOperations,
	createApiConversationBaseline,
	createPresentationBaseline,
	ensureTaskDirectoryExists,
	saveApiConversationProviderState,
} from "../storage/disk"
import { GlobalFileNames } from "../storage/fileNames"
import { operationLogExceedsBaselineThreshold } from "../storage/operationLog"
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
	/** Newly appended markdown text; consumers can forward the delta without materializing the full message. */
	appendedText?: string
	/** The old message before change (for update/delete) */
	previousMessage?: DiracMessage
	/** The entire previous array (for set) */
	previousMessages?: DiracMessage[]
}

export interface PresentationSnapshot {
	messages: DiracMessage[]
	offset: number
	generation: number
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

export const UI_MESSAGES_FLUSH_DEBOUNCE_MS = 250
export const UI_MESSAGES_FLUSH_MAX_DELAY_MS = 2_000
export const MAX_PENDING_PRESENTATION_PUBLICATION_BYTES = 2 * 1024 * 1024

export class MessageStateHandler extends EventEmitter<MessageStateHandlerEvents> {
	private workspaceRootPath?: string
	private apiConversationHistory: DiracStorageMessage[] = []
	private apiConversationProviderState: ApiConversationProviderState = {}
	private diracMessages: DiracMessage[] = []
	private taskIsFavorited: boolean
	private checkpointTracker: CheckpointTracker | undefined
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private taskId: string
	private ulid: string
	private taskState: TaskState
	private apiMetrics = getApiMetrics([])
	private metricContributionByMessageId = new Map<string, ReturnType<typeof getApiMetrics>>()
	private lastRelevantMessageId?: string
	private lastApiStatusMessageId?: string
	private lastModelInfo?: DiracStorageMessage["modelInfo"]

	// Mutex to prevent concurrent state modifications (RC-4)
	// Protects against data loss from race conditions when multiple
	// operations try to modify message state simultaneously
	// This follows the same pattern as Task.stateMutex for consistency
	private stateMutex = new Mutex()
	private persistenceMutex = new Mutex()

	private messageIndexById = new Map<string, number>()
	private cardMessageIndexById = new Map<string, number>()
	private pendingTextAppendsByMessageId = new Map<string, string[]>()
	private presentationOffset = -1
	private presentationStateGeneration = 0
	private apiHistoryOffset = -1
	private pendingPresentationOperations: PresentationOperation[] = []
	private pendingPresentationPersistenceBytes = 0
	private pendingPresentationPublications: PresentationOperation[] = []
	private pendingPresentationPublicationBytes = 0
	private presentationPublicationGapThroughOffset?: number
	private pendingApiConversationOperations: ApiConversationOperation[] = []
	private pendingApiConversationBytes = 0
	private uiFlushTimeout?: ReturnType<typeof setTimeout>
	private uiFlushDeadline?: number
	private apiHistoryFlushScheduled = false
	private persistenceRetired = false

	private recordPresentationOperation(operation: PresentationOperation): void {
		if (this.persistenceRetired) return
		const recordedOperation = structuredClone(operation)
		const operationBytes = Buffer.byteLength(JSON.stringify(recordedOperation), "utf8")
		this.pendingPresentationOperations.push(recordedOperation)
		this.pendingPresentationPersistenceBytes += operationBytes
		this.pendingPresentationPublications.push(recordedOperation)
		this.pendingPresentationPublicationBytes += operationBytes
		if (this.pendingPresentationPublicationBytes <= MAX_PENDING_PRESENTATION_PUBLICATION_BYTES) return
		this.pendingPresentationPublications = []
		this.pendingPresentationPublicationBytes = 0
		this.presentationPublicationGapThroughOffset = operation.offset
	}

	private recordApiConversationOperation(operation: ApiConversationOperation): void {
		if (this.persistenceRetired) return
		const recordedOperation = structuredClone(operation)
		this.pendingApiConversationOperations.push(recordedOperation)
		this.pendingApiConversationBytes += Buffer.byteLength(JSON.stringify(recordedOperation), "utf8")
	}

	private bufferPresentationAppend(messageId: string, text: string): void {
		const chunks = this.pendingTextAppendsByMessageId.get(messageId)
		if (chunks) chunks.push(text)
		else this.pendingTextAppendsByMessageId.set(messageId, [text])
	}

	private materializePresentationAppends(message: DiracMessage): boolean {
		const chunks = this.pendingTextAppendsByMessageId.get(message.id)
		if (!chunks) return false
		const appendedText = chunks.join("")
		if (message.content.type === DiracMessageType.MARKDOWN) {
			message.content.content += appendedText
		} else if (message.content.type === DiracMessageType.CARD) {
			message.content.card.body = `${message.content.card.body ?? ""}${appendedText}`
		} else {
			throw new Error(`Presentation append buffer refers to non-text message ${message.id}`)
		}
		this.pendingTextAppendsByMessageId.delete(message.id)
		return true
	}

	private materializeAllPresentationAppends(): void {
		for (const messageId of this.pendingTextAppendsByMessageId.keys()) {
			const index = this.requireMessageIndex(messageId)
			this.materializePresentationAppends(this.diracMessages[index])
		}
	}

	private async flushIfPersistenceBatchIsFull(): Promise<void> {
		if (
			this.pendingPresentationPersistenceBytes <= MAX_PENDING_PRESENTATION_PUBLICATION_BYTES &&
			this.pendingApiConversationBytes <= MAX_PENDING_PRESENTATION_PUBLICATION_BYTES
		)
			return
		await this.flushPendingWrites()
	}

	getPendingPresentationOperations(): PresentationOperation[] {
		return this.pendingPresentationPublications.slice()
	}

	hasPresentationPublicationGap(): boolean {
		return this.presentationPublicationGapThroughOffset !== undefined
	}

	acknowledgePresentationOperations(throughOffset: number): void {
		this.pendingPresentationPublications = this.pendingPresentationPublications.filter(
			(operation) => operation.offset > throughOffset,
		)
		this.pendingPresentationPublicationBytes = this.pendingPresentationPublications.reduce(
			(total, operation) => total + Buffer.byteLength(JSON.stringify(operation), "utf8"),
			0,
		)
		if (
			this.presentationPublicationGapThroughOffset !== undefined &&
			this.presentationPublicationGapThroughOffset <= throughOffset
		) {
			this.presentationPublicationGapThroughOffset = undefined
		}
	}

	hasPendingPresentationOperations(): boolean {
		return this.pendingPresentationPublications.length > 0
	}
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

	async capturePresentationSnapshot(): Promise<PresentationSnapshot> {
		return this.withStateLock(() => {
			this.materializeAllPresentationAppends()
			return {
				messages: structuredClone(this.diracMessages),
				offset: this.presentationOffset,
				generation: this.presentationStateGeneration,
			}
		})
	}

	/** Schedules a bounded UI snapshot flush without delaying live webview updates. */
	private scheduleUiFlush(): void {
		if (this.persistenceRetired) return
		const now = performance.now()
		this.uiFlushDeadline ??= now + UI_MESSAGES_FLUSH_MAX_DELAY_MS
		const delay = Math.min(UI_MESSAGES_FLUSH_DEBOUNCE_MS, Math.max(0, this.uiFlushDeadline - now))
		if (this.uiFlushTimeout) clearTimeout(this.uiFlushTimeout)
		this.uiFlushTimeout = setTimeout(() => {
			this.uiFlushTimeout = undefined
			this.uiFlushDeadline = undefined
			void this.flushPendingWrites().catch((error) => Logger.error("Failed to flush pending UI messages:", error))
		}, delay)
	}

	/** Keeps API-history persistence at its existing same-turn cadence. */
	private scheduleApiHistoryFlush(): void {
		if (this.persistenceRetired || this.apiHistoryFlushScheduled) return
		this.apiHistoryFlushScheduled = true
		queueMicrotask(() => {
			this.apiHistoryFlushScheduled = false
			void this.flushPendingWrites().catch((error) => Logger.error("Failed to flush pending API history:", error))
		})
	}

	private cancelScheduledUiFlush(): void {
		if (this.uiFlushTimeout) clearTimeout(this.uiFlushTimeout)
		this.uiFlushTimeout = undefined
		this.uiFlushDeadline = undefined
	}

	/** Prevents this task instance from writing after a same-ID replacement takes ownership. */
	async retirePersistence(): Promise<void> {
		this.persistenceRetired = true
		this.cancelScheduledUiFlush()
		this.apiHistoryFlushScheduled = false
		await this.persistenceMutex.withLock(() =>
			this.withStateLock(() => {
				this.pendingPresentationOperations = []
				this.pendingPresentationPersistenceBytes = 0
				this.pendingPresentationPublications = []
				this.pendingPresentationPublicationBytes = 0
				this.presentationPublicationGapThroughOffset = undefined
				this.pendingApiConversationOperations = []
				this.pendingApiConversationBytes = 0
			}),
		)
	}

	/** Captures pending records under the state lock, then appends them without blocking mutations. */
	private async persistPendingOperations(): Promise<void> {
		if (this.persistenceRetired) return
		const pending = await this.withStateLock(() => {
			const hasPendingApiConversation = this.pendingApiConversationOperations.length > 0
			const captured = {
				presentation: this.pendingPresentationOperations.splice(0),
				apiConversation: this.pendingApiConversationOperations.splice(0),
				apiConversationSnapshot: hasPendingApiConversation ? structuredClone(this.apiConversationHistory) : undefined,
				presentationBytes: this.pendingPresentationPersistenceBytes,
				apiConversationBytes: this.pendingApiConversationBytes,
			}
			this.pendingPresentationPersistenceBytes = 0
			this.pendingApiConversationBytes = 0
			return captured
		})

		let firstError: unknown
		try {
			await appendPresentationOperations(this.taskId, pending.presentation)
		} catch (error) {
			firstError = error
			await this.withStateLock(() => {
				this.pendingPresentationOperations.unshift(...pending.presentation)
				this.pendingPresentationPersistenceBytes += pending.presentationBytes
			})
		}
		try {
			await appendApiConversationOperations(this.taskId, pending.apiConversation, pending.apiConversationSnapshot)
		} catch (error) {
			firstError ??= error
			await this.withStateLock(() => {
				this.pendingApiConversationOperations.unshift(...pending.apiConversation)
				this.pendingApiConversationBytes += pending.apiConversationBytes
			})
		}
		if (firstError) throw firstError
		await this.createBaselinesWhenTailIsLarge()
	}

	private async createBaselinesWhenTailIsLarge(): Promise<void> {
		if (this.persistenceRetired) return
		const taskDirectory = await ensureTaskDirectoryExists(this.taskId)
		const presentationTailPath = `${taskDirectory}/${GlobalFileNames.uiMessageOperations}`
		const apiTailPath = `${taskDirectory}/${GlobalFileNames.apiConversationHistoryOperations}`
		const [presentationNeedsBaseline, apiNeedsBaseline] = await Promise.all([
			operationLogExceedsBaselineThreshold(presentationTailPath),
			operationLogExceedsBaselineThreshold(apiTailPath),
		])
		if (this.persistenceRetired || (!presentationNeedsBaseline && !apiNeedsBaseline)) return

		await this.withStateLock(async () => {
			if (this.persistenceRetired) return
			if (presentationNeedsBaseline && this.pendingPresentationOperations.length === 0) {
				this.materializeAllPresentationAppends()
				await createPresentationBaseline(this.taskId, this.diracMessages, this.presentationOffset)
			}
			if (apiNeedsBaseline && this.pendingApiConversationOperations.length === 0) {
				await createApiConversationBaseline(this.taskId, this.apiConversationHistory, this.apiHistoryOffset)
			}
		})
	}

	/**
	 * Flush any pending dirty writes to disk without holding the message-state lock during I/O.
	 * Safe to call at any time — no-op if nothing is dirty or this handler has been retired.
	 */
	async flushPendingWrites(): Promise<void> {
		this.cancelScheduledUiFlush()
		if (this.persistenceRetired) return
		await this.persistenceMutex.withLock(() => this.persistPendingOperations())
	}

	/**
	 * Flush task history to disk. Should be called at turn boundaries
	 * (end of API request cycle, after resume, after restore).
	 */
	async flushTaskHistory(): Promise<void> {
		await this.flushPendingWrites()
		if (this.persistenceRetired) return
		await this.persistenceMutex.withLock(() => this.updateTaskHistoryInternal())
	}

	getApiConversationHistory(): DiracStorageMessage[] {
		return this.apiConversationHistory
	}

	setApiConversationHistory(newHistory: DiracStorageMessage[], lastOffset = -1): void {
		this.apiConversationHistory = newHistory.map(removeUserInputMarkersFromMessage)
		this.apiHistoryOffset = lastOffset
		this.pendingApiConversationOperations = []
		this.pendingApiConversationBytes = 0
		this.lastModelInfo = findLastModelInfo(this.apiConversationHistory)
	}

	getApiConversationProviderState(): ApiConversationProviderState {
		return this.apiConversationProviderState
	}

	setApiConversationProviderState(state: ApiConversationProviderState): void {
		this.apiConversationProviderState = state
	}

	async overwriteApiConversationProviderState(state: ApiConversationProviderState): Promise<void> {
		await this.flushPendingWrites()
		if (this.persistenceRetired) return
		await this.persistenceMutex.withLock(async () => {
			if (this.persistenceRetired) return
			await this.withStateLock(async () => {
				this.apiConversationProviderState = state
				await saveApiConversationProviderState(this.taskId, state)
			})
		})
	}

	getDiracMessages(): DiracMessage[] {
		this.materializeAllPresentationAppends()
		return this.diracMessages
	}

	setDiracMessages(newMessages: DiracMessage[], lastOffset = -1) {
		const previousMessages = this.diracMessages
		this.diracMessages = newMessages
		this.presentationOffset = lastOffset
		this.pendingTextAppendsByMessageId.clear()
		this.pendingPresentationOperations = []
		this.pendingPresentationPersistenceBytes = 0
		this.pendingPresentationPublications = []
		this.pendingPresentationPublicationBytes = 0
		this.presentationPublicationGapThroughOffset = undefined
		this.presentationStateGeneration++
		this.rebuildMessageIndexes()
		this.rebuildHistoryProjection()
		this.emitDiracMessagesChanged({
			type: "set",
			messages: this.diracMessages,
			previousMessages,
		})
	}

	private rebuildMessageIndexes(): void {
		this.messageIndexById.clear()
		this.cardMessageIndexById.clear()
		this.lastApiStatusMessageId = undefined
		for (let index = 0; index < this.diracMessages.length; index++) {
			const message = this.diracMessages[index]
			this.messageIndexById.set(message.id, index)
			if (message.content.type === DiracMessageType.CARD) {
				this.cardMessageIndexById.set(message.content.card.id, index)
			}
			if (message.content.type === DiracMessageType.API_STATUS) this.lastApiStatusMessageId = message.id
		}
	}

	private updateLatestApiStatusAfterMutation(message: DiracMessage, wasApiStatus: boolean): void {
		if (message.content.type === DiracMessageType.API_STATUS) {
			const currentIndex = this.lastApiStatusMessageId ? (this.messageIndexById.get(this.lastApiStatusMessageId) ?? -1) : -1
			const messageIndex = this.messageIndexById.get(message.id) ?? -1
			if (messageIndex >= currentIndex) this.lastApiStatusMessageId = message.id
			return
		}
		if (wasApiStatus && message.id === this.lastApiStatusMessageId) this.findLastApiStatusMessageId()
	}

	private findLastApiStatusMessageId(): void {
		this.lastApiStatusMessageId = undefined
		for (let index = this.diracMessages.length - 1; index >= 0; index--) {
			const message = this.diracMessages[index]
			if (message.content.type !== DiracMessageType.API_STATUS) continue
			this.lastApiStatusMessageId = message.id
			return
		}
	}

	private rebuildHistoryProjection(): void {
		this.apiMetrics = getApiMetrics(this.diracMessages)
		this.metricContributionByMessageId.clear()
		this.lastRelevantMessageId = undefined
		for (const message of this.diracMessages) {
			this.metricContributionByMessageId.set(message.id, getApiMetrics([message]))
			if (isTaskHistoryRelevantMessage(message)) this.lastRelevantMessageId = message.id
		}
	}

	private updateHistoryProjection(
		message: DiracMessage | undefined,
		replaced?: {
			id: string
			metrics: ReturnType<typeof getApiMetrics>
			wasRelevant: boolean
		},
		reusePreviousMetrics = false,
	): void {
		if (replaced) {
			addApiMetrics(this.apiMetrics, replaced.metrics, -1)
			this.metricContributionByMessageId.delete(replaced.id)
		}
		if (message) {
			const metrics = reusePreviousMetrics && replaced ? replaced.metrics : getApiMetrics([message])
			this.metricContributionByMessageId.set(message.id, metrics)
			addApiMetrics(this.apiMetrics, metrics, 1)
		}

		const messageIsRelevant = message ? isTaskHistoryRelevantMessage(message) : false
		if (messageIsRelevant) {
			const currentLastIndex = this.lastRelevantMessageId
				? (this.messageIndexById.get(this.lastRelevantMessageId) ?? -1)
				: -1
			const messageIndex = this.messageIndexById.get(message!.id) ?? -1
			if (messageIndex >= currentLastIndex) this.lastRelevantMessageId = message!.id
			return
		}
		if (replaced?.wasRelevant && replaced.id === this.lastRelevantMessageId) this.findLastRelevantMessageId()
	}

	private historyProjectionBeforeMutation(message: DiracMessage): {
		id: string
		metrics: ReturnType<typeof getApiMetrics>
		wasRelevant: boolean
	} {
		return {
			id: message.id,
			metrics: this.metricContributionByMessageId.get(message.id) ?? getApiMetrics([message]),
			wasRelevant: isTaskHistoryRelevantMessage(message),
		}
	}

	private findLastRelevantMessageId(): void {
		this.lastRelevantMessageId = undefined
		for (let index = this.diracMessages.length - 1; index >= 0; index--) {
			if (!isTaskHistoryRelevantMessage(this.diracMessages[index])) continue
			this.lastRelevantMessageId = this.diracMessages[index].id
			return
		}
	}

	/**
	 * Update task history with current state.
	 * This can be slow due to folder size calculation, so it should be called
	 * outside of the stateMutex lock when possible.
	 */
	private async updateTaskHistoryInternal(): Promise<void> {
		if (this.persistenceRetired) return
		try {
			const taskMessage = this.diracMessages[0]
			if (!taskMessage) return
			const lastRelevantMessage =
				(this.lastRelevantMessageId ? this.getMessageById(this.lastRelevantMessageId) : undefined) ?? taskMessage
			const apiMetrics = this.apiMetrics
			const taskDirectory = await ensureTaskDirectoryExists(this.taskId)
			const taskDirectorySize = await getFolderSize.loose(taskDirectory)

			const cwd = await getCwd(getDesktopDir())
			const shadowGitConfigWorkTree = await this.checkpointTracker?.getShadowGitConfigWorkTree()
			if (this.persistenceRetired) return

			await this.updateTaskHistory({
				id: this.taskId,
				ulid: this.ulid,
				ts: lastRelevantMessage.ts,
				task: taskMessage.content.type === "markdown" ? taskMessage.content.content : "",
				tokensIn: apiMetrics.totalTokensIn + this.taskState.utilityPermissionInputTokens,
				tokensOut: apiMetrics.totalTokensOut + this.taskState.utilityPermissionOutputTokens,
				cacheWrites:
					this.taskState.utilityPermissionCacheWriteTokens === 0
						? apiMetrics.totalCacheWrites
						: (apiMetrics.totalCacheWrites ?? 0) + this.taskState.utilityPermissionCacheWriteTokens,
				cacheReads:
					this.taskState.utilityPermissionCacheReadTokens === 0
						? apiMetrics.totalCacheReads
						: (apiMetrics.totalCacheReads ?? 0) + this.taskState.utilityPermissionCacheReadTokens,
				totalCost: apiMetrics.totalCost + this.taskState.utilityPermissionCost,
				size: taskDirectorySize,
				shadowGitConfigWorkTree,
				cwdOnTaskInitialization: cwd,
				conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
				isFavorited: this.taskIsFavorited,
				workspaceRootPath: this.workspaceRootPath,
				checkpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
				modelId: this.lastModelInfo?.modelId,
			})
		} catch (error) {
			Logger.error("Failed to update task history:", error)
			throw error
		}
	}

	/**
	 * Save dirac messages and update task history (public API with mutex protection)
	 * This is the main entry point for saving message state from external callers
	 */
	async saveDiracMessagesAndUpdateHistory(): Promise<void> {
		await this.flushPendingWrites()
		if (this.persistenceRetired) return
		await this.persistenceMutex.withLock(() => this.updateTaskHistoryInternal())
	}

	async addToApiConversationHistory(message: DiracStorageMessage) {
		await this.withStateLock(async () => {
			const storedMessage = removeUserInputMarkersFromMessage(message)
			this.apiConversationHistory.push(storedMessage)
			if (storedMessage.modelInfo) this.lastModelInfo = storedMessage.modelInfo
			this.recordApiConversationOperation({
				offset: ++this.apiHistoryOffset,
				type: "append_message",
				message: structuredClone(storedMessage),
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleApiHistoryFlush()
	}

	async appendToLastApiConversationUserMessage(contentBlock: DiracUserContent): Promise<DiracStorageMessage> {
		const sanitizedContentBlock = removeUserInputMarkersFromContent(contentBlock) as DiracUserContent
		const message = await this.withStateLock(() => {
			const lastMessage = this.apiConversationHistory.at(-1)
			if (!lastMessage || lastMessage.role !== "user") {
				throw new Error("Cannot append content without a final user API conversation message")
			}
			if (typeof lastMessage.content === "string") {
				lastMessage.content = [{ type: "text", text: lastMessage.content }, sanitizedContentBlock]
			} else {
				lastMessage.content.push(sanitizedContentBlock)
			}
			this.recordApiConversationOperation({
				offset: ++this.apiHistoryOffset,
				type: "append_user_content",
				content: structuredClone(sanitizedContentBlock),
			})
			return lastMessage
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleApiHistoryFlush()
		return message
	}

	async overwriteApiConversationHistory(newHistory: DiracStorageMessage[]): Promise<void> {
		await this.flushPendingWrites()
		await this.withStateLock(() => {
			this.apiConversationHistory = newHistory.map(removeUserInputMarkersFromMessage)
			this.lastModelInfo = findLastModelInfo(this.apiConversationHistory)
			this.recordApiConversationOperation({
				offset: ++this.apiHistoryOffset,
				type: "reset",
				messages: this.apiConversationHistory,
			})
		})
		await this.flushPendingWrites()
	}

	async recordDeliveredSteeringMessageIds(messageIds: readonly string[]): Promise<void> {
		await this.flushPendingWrites()
		if (this.persistenceRetired) return
		await this.persistenceMutex.withLock(async () => {
			if (this.persistenceRetired) return
			await this.withStateLock(async () => {
				const deliveredIds = new Set(this.apiConversationProviderState.deliveredSteeringMessageIds ?? [])
				for (const messageId of messageIds) deliveredIds.add(messageId)
				this.apiConversationProviderState = {
					...this.apiConversationProviderState,
					deliveredSteeringMessageIds: [...deliveredIds],
				}
				await saveApiConversationProviderState(this.taskId, this.apiConversationProviderState)
			})
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
			if (this.messageIndexById.has(message.id)) throw new Error(`Message with id ${message.id} already exists`)
			if (message.content.type === DiracMessageType.CARD && this.cardMessageIndexById.has(message.content.card.id)) {
				throw new Error(`Card with id ${message.content.card.id} already exists`)
			}
			message.conversationHistoryIndex = this.apiConversationHistory.length - 1
			message.conversationHistoryDeletedRange = this.taskState.conversationHistoryDeletedRange
			const index = this.diracMessages.length
			this.diracMessages.push(message)
			this.messageIndexById.set(message.id, index)
			if (message.content.type === DiracMessageType.CARD) {
				this.cardMessageIndexById.set(message.content.card.id, index)
			}
			if (message.content.type === DiracMessageType.API_STATUS) this.lastApiStatusMessageId = message.id
			this.updateHistoryProjection(message)
			this.emitDiracMessagesChanged({
				type: "add",
				messages: this.diracMessages,
				index,
				message,
			})
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "create",
				message,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}

	/**
	 * Replace the entire diracMessages array with new messages
	 * Protected by mutex to prevent concurrent modifications (RC-4)
	 */
	async overwriteDiracMessages(newMessages: DiracMessage[]) {
		await this.flushPendingWrites()
		await this.withStateLock(() => {
			const previousMessages = this.diracMessages
			this.pendingTextAppendsByMessageId.clear()
			this.diracMessages = newMessages
			this.rebuildMessageIndexes()
			this.rebuildHistoryProjection()
			this.emitDiracMessagesChanged({
				type: "set",
				messages: this.diracMessages,
				previousMessages,
			})
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "reset",
				messages: newMessages,
			})
		})
		await this.flushPendingWrites()
	}

	/**
	 * Find the index of a message by its ID
	 */
	findMessageIndexById(id: string): number {
		return this.messageIndexById.get(id) ?? -1
	}

	getMessageById(id: string): DiracMessage | undefined {
		const index = this.messageIndexById.get(id)
		if (index === undefined) return undefined
		const message = this.diracMessages[index]
		this.materializePresentationAppends(message)
		return message
	}

	getLatestApiStatusMessage(): DiracMessage | undefined {
		return this.lastApiStatusMessageId ? this.getMessageById(this.lastApiStatusMessageId) : undefined
	}

	getPresentationOffset(): number {
		return this.presentationOffset
	}

	getPresentationStateGeneration(): number {
		return this.presentationStateGeneration
	}

	/**
	 * Find the index of a message containing a card with the specified ID
	 */
	findMessageIndexByCardId(cardId: string): number {
		return this.cardMessageIndexById.get(cardId) ?? -1
	}

	async patchCardById(cardId: string, patch: Partial<Omit<Card, "id">>): Promise<Readonly<Card>> {
		const updatedCard = await this.withStateLock(() => {
			const index = this.requireCardMessageIndex(cardId)
			const message = this.diracMessages[index]
			if (message.content.type !== DiracMessageType.CARD) throw new Error(`Message with card id ${cardId} is not a card`)
			this.materializePresentationAppends(message)
			const before = this.historyProjectionBeforeMutation(message)
			Object.assign(message.content.card, patch)
			this.updateHistoryProjection(message, before, patch.header === undefined && patch.body === undefined && patch.rawOutput === undefined)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "patch_card",
				id: message.id,
				patch,
			})
			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				message,
			})
			return message.content.card
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
		return updatedCard
	}

	async appendCardBodyById(cardId: string, text: string): Promise<void> {
		await this.withStateLock(() => {
			const index = this.requireCardMessageIndex(cardId)
			const message = this.diracMessages[index]
			if (message.content.type !== DiracMessageType.CARD) throw new Error(`Message with card id ${cardId} is not a card`)
			this.bufferPresentationAppend(message.id, text)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "append_card_body",
				id: message.id,
				text,
			})
			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				message,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}

	async appendMarkdownById(id: string, text: string): Promise<void> {
		await this.withStateLock(() => {
			const index = this.requireMessageIndex(id)
			const message = this.diracMessages[index]
			if (message.content.type !== DiracMessageType.MARKDOWN) throw new Error(`Message with id ${id} is not markdown`)
			this.bufferPresentationAppend(id, text)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "append_markdown",
				id,
				text,
			})
			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				message,
				appendedText: text,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}

	async patchMarkdownById(
		id: string,
		patch: Partial<Omit<Extract<DiracMessage["content"], { type: DiracMessageType.MARKDOWN }>, "type" | "content">>,
	): Promise<void> {
		await this.withStateLock(() => {
			const index = this.requireMessageIndex(id)
			const message = this.diracMessages[index]
			if (message.content.type !== DiracMessageType.MARKDOWN) throw new Error(`Message with id ${id} is not markdown`)
			this.materializePresentationAppends(message)
			const before = this.historyProjectionBeforeMutation(message)
			Object.assign(message.content, patch)
			this.updateHistoryProjection(message, before, true)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "patch_markdown",
				id,
				patch,
			})
			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				message,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}

	async patchApiStatusById(
		id: string,
		patch: Partial<DiracApiReqInfo>,
		deletions: (keyof DiracApiReqInfo)[] = [],
	): Promise<void> {
		await this.withStateLock(() => {
			const index = this.requireMessageIndex(id)
			const message = this.diracMessages[index]
			if (message.content.type !== DiracMessageType.API_STATUS)
				throw new Error(`Message with id ${id} is not an API status`)
			const before = this.historyProjectionBeforeMutation(message)
			Object.assign(message.content.status, patch)
			for (const key of deletions) delete message.content.status[key]
			this.updateHistoryProjection(message, before)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "patch_api_status",
				id,
				patch,
				...(deletions.length > 0 ? { deletions } : {}),
			})
			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				message,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}

	private requireMessageIndex(id: string): number {
		const index = this.messageIndexById.get(id)
		if (index === undefined) throw new Error(`Message with id ${id} not found`)
		return index
	}

	private requireCardMessageIndex(cardId: string): number {
		const index = this.cardMessageIndexById.get(cardId)
		if (index === undefined) throw new Error(`Card with id ${cardId} not found`)
		return index
	}
	/**
	 * Update a specific message in the diracMessages array
	 * The entire operation (validate, update, save) is atomic to prevent races (RC-4)
	 */
	async updateDiracMessage(index: number, updates: Partial<Omit<DiracMessage, "id">>): Promise<void> {
		await this.withStateLock(() => {
			if (index < 0 || index >= this.diracMessages.length) {
				throw new Error(`Invalid message index: ${index}`)
			}

			const message = this.diracMessages[index]
			this.materializePresentationAppends(message)
			const before = this.historyProjectionBeforeMutation(message)
			const wasApiStatus = message.content.type === DiracMessageType.API_STATUS
			Object.assign(message, updates)
			this.updateLatestApiStatusAfterMutation(message, wasApiStatus)
			this.updateHistoryProjection(message, before, updates.content === undefined)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "patch_message",
				id: message.id,
				patch: updates,
			})

			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				message,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}

	async patchMessageById(id: string, patch: Partial<Omit<DiracMessage, "id">>): Promise<void> {
		await this.withStateLock(() => {
			const index = this.requireMessageIndex(id)
			const message = this.diracMessages[index]
			this.materializePresentationAppends(message)
			const before = this.historyProjectionBeforeMutation(message)
			const wasApiStatus = message.content.type === DiracMessageType.API_STATUS
			Object.assign(message, patch)
			this.updateLatestApiStatusAfterMutation(message, wasApiStatus)
			this.updateHistoryProjection(message, before, patch.content === undefined)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "patch_message",
				id,
				patch,
			})
			this.emitDiracMessagesChanged({
				type: "update",
				messages: this.diracMessages,
				index,
				message,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}

	/**
	 * Delete a specific message from the diracMessages array
	 * The entire operation (validate, delete, save) is atomic to prevent races (RC-4)
	 */
	async deleteDiracMessage(index: number): Promise<void> {
		await this.withStateLock(() => {
			if (index < 0 || index >= this.diracMessages.length) {
				throw new Error(`Invalid message index: ${index}`)
			}

			const previousMessage = this.diracMessages[index]
			this.materializePresentationAppends(previousMessage)
			const before = this.historyProjectionBeforeMutation(previousMessage)
			this.diracMessages.splice(index, 1)
			this.pendingTextAppendsByMessageId.delete(previousMessage.id)
			this.rebuildMessageIndexes()
			this.updateHistoryProjection(undefined, before)
			this.recordPresentationOperation({
				offset: ++this.presentationOffset,
				type: "delete",
				id: previousMessage.id,
			})

			this.emitDiracMessagesChanged({
				type: "delete",
				messages: this.diracMessages,
				index,
				previousMessage,
			})
		})
		await this.flushIfPersistenceBatchIsFull()
		this.scheduleUiFlush()
	}
}

function isTaskHistoryRelevantMessage(message: DiracMessage): boolean {
	return !(
		message.content.type === DiracMessageType.CARD &&
		(message.content.card.header.includes("Resume") || message.content.card.header.includes("Task Resumed"))
	)
}

function addApiMetrics(
	target: ReturnType<typeof getApiMetrics>,
	contribution: ReturnType<typeof getApiMetrics>,
	direction: 1 | -1,
): void {
	target.totalTokensIn += direction * contribution.totalTokensIn
	target.totalTokensOut += direction * contribution.totalTokensOut
	target.totalCost += direction * contribution.totalCost
	target.totalReasoningTokens += direction * contribution.totalReasoningTokens
	if (contribution.totalCacheWrites !== undefined) {
		target.totalCacheWrites = (target.totalCacheWrites ?? 0) + direction * contribution.totalCacheWrites
	}
	if (contribution.totalCacheReads !== undefined) {
		target.totalCacheReads = (target.totalCacheReads ?? 0) + direction * contribution.totalCacheReads
	}
	const totalPromptTokens = target.totalTokensIn + (target.totalCacheWrites ?? 0) + (target.totalCacheReads ?? 0)
	target.cacheHitRate = totalPromptTokens > 0 ? (target.totalCacheReads ?? 0) / totalPromptTokens : 0
}

function findLastModelInfo(messages: readonly DiracStorageMessage[]): DiracStorageMessage["modelInfo"] {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].modelInfo) return messages[index].modelInfo
	}
	return undefined
}
