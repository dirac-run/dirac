import { Anthropic } from "@anthropic-ai/sdk"
import type { ApiConversationProviderState } from "@core/api/conversation"
import { CardKind, CardStatus, DiracMessage, DiracMessageType, SteeringTranscriptStatus } from "@shared/ExtensionMessage"
import type { DiracStorageMessage, DiracUserContent } from "@shared/messages/content"
import type { PresentationOperation } from "@shared/PresentationOperation"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { syncWorker } from "@/shared/services/worker/sync"
import { atomicWriteFile } from "./atomicWrite"
import { ensureTaskDirectoryExists } from "./directoryEnsurers"
import { GlobalFileNames } from "./fileNames"
import { appendOperationRecords, archiveOperationLog, replayOperationRecords, writeFramedBaseline } from "./operationLog"

export type ApiConversationOperation =
	| { offset: number; type: "append_message"; message: DiracStorageMessage }
	| { offset: number; type: "append_user_content"; content: DiracUserContent }
	| { offset: number; type: "reset"; messages: DiracStorageMessage[] }

export interface SavedPresentationHistory {
	messages: DiracMessage[]
	lastOffset: number
}

export interface SavedApiConversationHistory {
	messages: DiracStorageMessage[]
	lastOffset: number
}

type ApiConversationBaselineRecord = { type: "baseline"; offset: number } | { type: "message"; message: DiracStorageMessage }

type PresentationBaselineRecord = { type: "baseline"; offset: number } | { type: "message"; message: DiracMessage }

// Reads the saved API conversation history for a task, returning [] if absent.
export async function getSavedApiConversationHistory(taskId: string): Promise<Anthropic.MessageParam[]> {
	return (await getSavedApiConversationState(taskId)).messages
}

export async function getSavedApiConversationState(taskId: string): Promise<SavedApiConversationHistory> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	const filePath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
	const baselinePath = path.join(taskDirectory, GlobalFileNames.apiConversationHistoryBaseline)
	let { messages, lastOffset } = await readApiConversationBaseline(filePath, baselinePath)
	const operationPath = path.join(path.dirname(filePath), GlobalFileNames.apiConversationHistoryOperations)
	await replayOperationRecords<ApiConversationOperation>(operationPath, (operation) => {
		if (operation.offset <= lastOffset) return
		assertNextOffset(operation.offset, lastOffset, operationPath, operation.type === "reset")
		lastOffset = operation.offset
		messages = applyApiConversationOperation(messages, operation)
	})
	return { messages, lastOffset }
}

export async function appendApiConversationOperations(
	taskId: string,
	operations: readonly ApiConversationOperation[],
	completeHistory?: readonly DiracStorageMessage[],
): Promise<number> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	const appendedBytes = await appendOperationRecords(
		path.join(taskDirectory, GlobalFileNames.apiConversationHistoryOperations),
		operations,
	)
	if (operations.length > 0 && completeHistory) {
		syncWorker().enqueue(taskId, GlobalFileNames.apiConversationHistory, JSON.stringify(completeHistory))
	}
	return appendedBytes
}

export async function createApiConversationBaseline(
	taskId: string,
	messages: readonly DiracStorageMessage[],
	offset: number,
): Promise<void> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	const records = function* (): Generator<ApiConversationBaselineRecord> {
		yield { type: "baseline", offset }
		for (const message of messages) yield { type: "message", message }
	}
	await writeFramedBaseline(path.join(taskDirectory, GlobalFileNames.apiConversationHistoryBaseline), records())
	await archiveOperationLog(path.join(taskDirectory, GlobalFileNames.apiConversationHistoryOperations), offset)
}

// Reads provider-native conversation state separately from the generic API transcript.
export async function getSavedApiConversationProviderState(taskId: string): Promise<ApiConversationProviderState> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.apiConversationProviderState)
	if (!(await fileExistsAtPath(filePath))) return {}
	return JSON.parse(await fs.readFile(filePath, "utf8"))
}

// Persists opaque provider-native checkpoints without encoding them as generic messages.
export async function saveApiConversationProviderState(taskId: string, state: ApiConversationProviderState): Promise<void> {
	const fileName = GlobalFileNames.apiConversationProviderState
	const data = JSON.stringify(state)
	syncWorker().enqueue(taskId, fileName, data)
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), fileName)
	await atomicWriteFile(filePath, data)
}

// Persists API conversation history for a task, queuing remote sync without blocking.
export async function saveApiConversationHistory(taskId: string, apiConversationHistory: Anthropic.MessageParam[]) {
	if (apiConversationHistory.length === 0) {
		return
	}
	try {
		const fileName = GlobalFileNames.apiConversationHistory
		const taskDirectory = await ensureTaskDirectoryExists(taskId)
		const usesIncrementalStorage =
			(await fileExistsAtPath(path.join(taskDirectory, GlobalFileNames.apiConversationHistoryBaseline))) ||
			(await fileExistsAtPath(path.join(taskDirectory, GlobalFileNames.apiConversationHistoryOperations)))
		if (usesIncrementalStorage) {
			const current = await getSavedApiConversationState(taskId)
			await appendApiConversationOperations(
				taskId,
				[
					{
						offset: current.lastOffset + 1,
						type: "reset",
						messages: apiConversationHistory,
					},
				],
				apiConversationHistory,
			)
			return
		}
		const data = JSON.stringify(apiConversationHistory)
		syncWorker().enqueue(taskId, fileName, data)
		const filePath = path.join(taskDirectory, fileName)
		await atomicWriteFile(filePath, data)
	} catch (error) {
		Logger.error("Failed to save API conversation history:", error)
		throw error
	}
}

// Reads saved Dirac UI messages for a task, migrating the legacy filename after validating its contents.
export async function getSavedDiracMessages(taskId: string): Promise<DiracMessage[]> {
	return (await getSavedPresentationHistory(taskId)).messages
}

export async function getSavedPresentationHistory(taskId: string): Promise<SavedPresentationHistory> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	const filePath = path.join(taskDirectory, GlobalFileNames.uiMessages)
	const baselinePath = path.join(taskDirectory, GlobalFileNames.uiMessagesBaseline)
	const baseline = await readPresentationBaseline(taskDirectory, filePath, baselinePath)
	const operationPath = path.join(taskDirectory, GlobalFileNames.uiMessageOperations)
	return replayPresentationOperationPaths([operationPath], baseline.messages, baseline.lastOffset)
}

export async function appendPresentationOperations(
	taskId: string,
	operations: readonly PresentationOperation[],
): Promise<number> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	return appendOperationRecords(path.join(taskDirectory, GlobalFileNames.uiMessageOperations), operations)
}

export async function createPresentationBaseline(
	taskId: string,
	messages: readonly DiracMessage[],
	offset: number,
): Promise<void> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	const records = function* (): Generator<PresentationBaselineRecord> {
		yield { type: "baseline", offset }
		for (const message of messages) yield { type: "message", message }
	}
	await writeFramedBaseline(path.join(taskDirectory, GlobalFileNames.uiMessagesBaseline), records())
	await archiveOperationLog(path.join(taskDirectory, GlobalFileNames.uiMessageOperations), offset)
}

/** Replays retained operation segments to the first state containing a checkpoint message. */
export async function getPresentationHistoryAtMessage(taskId: string, messageId: string): Promise<DiracMessage[]> {
	const taskDirectory = await ensureTaskDirectoryExists(taskId)
	const legacyPath = path.join(taskDirectory, GlobalFileNames.uiMessages)
	const messages = (await fileExistsAtPath(legacyPath))
		? await parseSavedDiracMessages(await fs.readFile(legacyPath, "utf8"), legacyPath)
		: []
	const legacyTargetIndex = messages.findIndex((message) => message.id === messageId)
	if (legacyTargetIndex !== -1) return structuredClone(messages.slice(0, legacyTargetIndex + 1))

	let targetState: DiracMessage[] | undefined
	await replayPresentationOperationPaths(
		await presentationOperationHistoryPaths(taskDirectory),
		messages,
		-1,
		(state) => {
			if (targetState) return
			const targetIndex = state.messageIndexes.get(messageId)
			if (targetIndex === undefined) return
			targetState = snapshotPresentationMessages(state).slice(0, targetIndex + 1)
		},
	)
	if (!targetState) throw new Error(`Presentation checkpoint message ${messageId} is absent from task ${taskId}`)
	return targetState
}

async function readApiConversationBaseline(legacyPath: string, baselinePath: string): Promise<SavedApiConversationHistory> {
	if (!(await fileExistsAtPath(baselinePath))) {
		const messages = (await fileExistsAtPath(legacyPath))
			? (JSON.parse(await fs.readFile(legacyPath, "utf8")) as DiracStorageMessage[])
			: []
		return { messages, lastOffset: -1 }
	}

	const messages: DiracStorageMessage[] = []
	let lastOffset: number | undefined
	await replayOperationRecords<ApiConversationBaselineRecord>(baselinePath, (record, lineNumber) => {
		if (lineNumber === 1 && record.type === "baseline" && Number.isSafeInteger(record.offset)) {
			lastOffset = record.offset
			return
		}
		if (lastOffset === undefined || record.type !== "message") {
			throw new Error(`Invalid API conversation baseline record ${lineNumber}`)
		}
		messages.push(record.message)
	})
	if (lastOffset === undefined) throw new Error(`API conversation baseline has no header: ${baselinePath}`)
	return { messages, lastOffset }
}

async function readPresentationBaseline(
	taskDirectory: string,
	legacyPath: string,
	baselinePath: string,
): Promise<SavedPresentationHistory> {
	if (!(await fileExistsAtPath(baselinePath))) {
		if (await fileExistsAtPath(legacyPath)) {
			return {
				messages: await parseSavedDiracMessages(await fs.readFile(legacyPath, "utf8"), legacyPath),
				lastOffset: -1,
			}
		}
		const oldPath = path.join(taskDirectory, "claude_messages.json")
		if (!(await fileExistsAtPath(oldPath))) return { messages: [], lastOffset: -1 }
		const contents = await fs.readFile(oldPath, "utf8")
		const messages = await parseSavedDiracMessages(contents, oldPath)
		await atomicWriteFile(legacyPath, JSON.stringify(messages))
		await fs.unlink(oldPath)
		return { messages, lastOffset: -1 }
	}

	const messages: DiracMessage[] = []
	let lastOffset: number | undefined
	await replayOperationRecords<PresentationBaselineRecord>(baselinePath, (record, lineNumber) => {
		if (lineNumber === 1 && record.type === "baseline" && Number.isSafeInteger(record.offset)) {
			lastOffset = record.offset
			return
		}
		if (lastOffset === undefined || record.type !== "message" || !isReadableDiracMessage(record.message)) {
			throw new Error(`Invalid presentation baseline record ${lineNumber}`)
		}
		messages.push(record.message)
	})
	if (lastOffset === undefined) throw new Error(`Presentation baseline has no header: ${baselinePath}`)
	return { messages, lastOffset }
}

function applyApiConversationOperation(
	messages: DiracStorageMessage[],
	operation: ApiConversationOperation,
): DiracStorageMessage[] {
	if (operation.type === "reset") return operation.messages
	if (operation.type === "append_message") {
		messages.push(operation.message)
		return messages
	}
	const lastMessage = messages.at(-1)
	if (!lastMessage || lastMessage.role !== "user") {
		throw new Error("API history operation appends content without a final user message")
	}
	if (typeof lastMessage.content === "string") {
		lastMessage.content = [{ type: "text", text: lastMessage.content }, operation.content]
	} else {
		lastMessage.content.push(operation.content)
	}
	return messages
}

interface PresentationReplayState {
	messages: DiracMessage[]
	messageIndexes: Map<string, number>
	appendChunks: Map<string, string[]>
	lastOffset: number
}

function createPresentationReplayState(messages: DiracMessage[], lastOffset: number): PresentationReplayState {
	return {
		messages,
		messageIndexes: indexMessagesById(messages),
		appendChunks: new Map(),
		lastOffset,
	}
}

function clonePresentationReplayState(state: PresentationReplayState): PresentationReplayState {
	const messages = structuredClone(state.messages)
	return {
		messages,
		messageIndexes: indexMessagesById(messages),
		appendChunks: new Map(
			[...state.appendChunks].map(([messageId, chunks]) => [messageId, chunks.slice()] as const),
		),
		lastOffset: state.lastOffset,
	}
}

function snapshotPresentationMessages(state: PresentationReplayState): DiracMessage[] {
	const snapshot = clonePresentationReplayState(state)
	materializeAllPresentationAppends(snapshot.messages, snapshot.messageIndexes, snapshot.appendChunks)
	return snapshot.messages
}

function applyPresentationOperationToState(
	state: PresentationReplayState,
	operation: PresentationOperation,
	operationPath: string,
): void {
	assertNextOffset(operation.offset, state.lastOffset, operationPath, operation.type === "reset")
	const applied = applyPresentationOperation(state.messages, state.messageIndexes, state.appendChunks, operation)
	state.messages = applied.messages
	state.messageIndexes = applied.messageIndexes
	state.lastOffset = operation.offset
}

/**
 * Replays the canonical presentation branch while quarantining the stale writer branch produced by
 * same-task cancellation recreation. Its first late mutation restarts at the latest reset's offset
 * and targets state that existed immediately before that reset.
 */
async function replayPresentationOperationPaths(
	operationPaths: readonly string[],
	initialMessages: DiracMessage[],
	initialOffset: number,
	onCanonicalState?: (state: PresentationReplayState) => void,
): Promise<SavedPresentationHistory> {
	const canonical = createPresentationReplayState(initialMessages, initialOffset)
	let resetCandidate: { offset: number; preResetState: PresentationReplayState } | undefined
	let staleBranch: PresentationReplayState | undefined
	let activeBranch: "canonical" | "stale" = "canonical"
	let recoveredPath: string | undefined

	const applyCanonical = (operation: PresentationOperation, operationPath: string): void => {
		if (operation.offset <= canonical.lastOffset) return
		const preResetState = operation.type === "reset" ? clonePresentationReplayState(canonical) : undefined
		applyPresentationOperationToState(canonical, operation, operationPath)
		if (preResetState) {
			resetCandidate = { offset: operation.offset, preResetState }
			staleBranch = undefined
			activeBranch = "canonical"
		}
		onCanonicalState?.(canonical)
	}

	for (const operationPath of operationPaths) {
		await replayOperationRecords<PresentationOperation>(operationPath, (operation) => {
			if (operation.type === "reset") {
				applyCanonical(operation, operationPath)
				return
			}

			if (staleBranch) {
				const activeState = activeBranch === "canonical" ? canonical : staleBranch
				if (operation.offset === activeState.lastOffset + 1) {
					applyPresentationOperationToState(activeState, operation, operationPath)
					if (activeBranch === "canonical") onCanonicalState?.(canonical)
					return
				}

				const nextBranch = activeBranch === "canonical" ? "stale" : "canonical"
				const nextState = nextBranch === "canonical" ? canonical : staleBranch
				if (operation.offset !== nextState.lastOffset + 1) {
					throw new Error(
						`Presentation operation offset ${operation.offset} continues neither the canonical branch after ${canonical.lastOffset} nor the stale branch after ${staleBranch.lastOffset}`,
					)
				}
				activeBranch = nextBranch
				applyPresentationOperationToState(nextState, operation, operationPath)
				if (activeBranch === "canonical") onCanonicalState?.(canonical)
				return
			}

			if (
				resetCandidate &&
				operation.type !== "create" &&
				operation.offset === resetCandidate.offset &&
				operation.offset <= canonical.lastOffset &&
				resetCandidate.preResetState.messageIndexes.has(operation.id)
			) {
				staleBranch = clonePresentationReplayState(resetCandidate.preResetState)
				applyPresentationOperationToState(staleBranch, operation, operationPath)
				activeBranch = "stale"
				recoveredPath ??= operationPath
				return
			}

			applyCanonical(operation, operationPath)
		})
	}

	if (recoveredPath) Logger.warn(`[Task History] Ignored stale presentation writes after reset in ${recoveredPath}`)
	materializeAllPresentationAppends(canonical.messages, canonical.messageIndexes, canonical.appendChunks)
	return { messages: canonical.messages, lastOffset: canonical.lastOffset }
}

function materializePresentationAppends(
	messages: DiracMessage[],
	messageIndexes: Map<string, number>,
	appendChunks: Map<string, string[]>,
	messageId: string,
): void {
	const chunks = appendChunks.get(messageId)
	if (!chunks) return
	const index = messageIndexes.get(messageId)
	if (index === undefined) throw new Error(`Presentation append refers to missing ID ${messageId}`)
	const message = messages[index]
	const appendedText = chunks.join("")
	if (message.content.type === DiracMessageType.MARKDOWN) {
		message.content.content += appendedText
	} else if (message.content.type === DiracMessageType.CARD) {
		message.content.card.body = `${message.content.card.body ?? ""}${appendedText}`
	} else {
		throw new Error(`Presentation append refers to non-text message ${messageId}`)
	}
	appendChunks.delete(messageId)
}

function materializeAllPresentationAppends(
	messages: DiracMessage[],
	messageIndexes: Map<string, number>,
	appendChunks: Map<string, string[]>,
): void {
	for (const messageId of appendChunks.keys()) {
		materializePresentationAppends(messages, messageIndexes, appendChunks, messageId)
	}
}

function applyPresentationOperation(
	messages: DiracMessage[],
	messageIndexes: Map<string, number>,
	appendChunks: Map<string, string[]>,
	operation: PresentationOperation,
): { messages: DiracMessage[]; messageIndexes: Map<string, number> } {
	if (operation.type === "reset") {
		appendChunks.clear()
		return {
			messages: operation.messages,
			messageIndexes: indexMessagesById(operation.messages),
		}
	}
	if (operation.type === "create") {
		if (messageIndexes.has(operation.message.id)) throw new Error(`Duplicate presentation ID ${operation.message.id}`)
		messageIndexes.set(operation.message.id, messages.length)
		messages.push(operation.message)
		return { messages, messageIndexes }
	}

	const index = messageIndexes.get(operation.id)
	if (index === undefined) throw new Error(`Presentation operation refers to missing ID ${operation.id}`)
	if (operation.type === "append_card_body" || operation.type === "append_markdown") {
		const chunks = appendChunks.get(operation.id)
		if (chunks) chunks.push(operation.text)
		else appendChunks.set(operation.id, [operation.text])
		return { messages, messageIndexes }
	}
	if (operation.type === "delete") {
		appendChunks.delete(operation.id)
		messages.splice(index, 1)
		return { messages, messageIndexes: indexMessagesById(messages) }
	}

	materializePresentationAppends(messages, messageIndexes, appendChunks, operation.id)
	const message = messages[index]
	if (operation.type === "patch_message") {
		Object.assign(message, operation.patch)
		return { messages, messageIndexes }
	}
	if (operation.type === "patch_card") {
		if (message.content.type !== DiracMessageType.CARD) throw new Error(`Presentation ID ${operation.id} is not a Card`)
		Object.assign(message.content.card, operation.patch)
		return { messages, messageIndexes }
	}
	if (operation.type === "patch_api_status") {
		if (message.content.type !== DiracMessageType.API_STATUS) {
			throw new Error(`Presentation ID ${operation.id} is not an API status`)
		}
		Object.assign(message.content.status, operation.patch)
		for (const key of operation.deletions ?? []) delete message.content.status[key]
		return { messages, messageIndexes }
	}
	if (message.content.type !== DiracMessageType.MARKDOWN) {
		throw new Error(`Presentation ID ${operation.id} is not markdown`)
	}
	Object.assign(message.content, operation.patch)
	return { messages, messageIndexes }
}

async function presentationOperationHistoryPaths(taskDirectory: string): Promise<string[]> {
	const operationName = GlobalFileNames.uiMessageOperations
	const archivePrefix = `${operationName}.archive.`
	const entries = await fs.readdir(taskDirectory)
	const archives = entries
		.filter((entry) => entry.startsWith(archivePrefix))
		.map((entry) => ({
			entry,
			offset: Number(entry.slice(archivePrefix.length)),
		}))
		.filter(({ offset }) => Number.isSafeInteger(offset))
		.sort((left, right) => left.offset - right.offset)
		.map(({ entry }) => path.join(taskDirectory, entry))
	const activePath = path.join(taskDirectory, operationName)
	if (await fileExistsAtPath(activePath)) archives.push(activePath)
	return archives
}

function indexMessagesById(messages: readonly DiracMessage[]): Map<string, number> {
	const indexes = new Map<string, number>()
	for (let index = 0; index < messages.length; index++) indexes.set(messages[index].id, index)
	return indexes
}

function assertNextOffset(offset: number, previousOffset: number, filePath: string, resetCanBridgeGap = false): void {
	if (!Number.isSafeInteger(offset) || (offset !== previousOffset + 1 && !resetCanBridgeGap)) {
		throw new Error(`Non-contiguous operation offset ${offset} after ${previousOffset} in ${filePath}`)
	}
}

async function parseSavedDiracMessages(contents: string, filePath: string): Promise<DiracMessage[]> {
	let parsed: unknown
	try {
		parsed = JSON.parse(contents)
	} catch (error) {
		throw new Error(`Saved task transcript is not valid JSON: ${filePath}`, {
			cause: error,
		})
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`Saved task transcript is not an array: ${filePath}`)
	}

	const readableMessages = parsed.filter(isReadableDiracMessage)
	const skippedMessages = parsed.length - readableMessages.length
	if (parsed.length > 0 && readableMessages.length === 0) {
		throw new Error(`Saved task transcript uses an unsupported or unreadable format: ${filePath}`)
	}
	if (skippedMessages > 0) {
		await backupTranscriptBeforeSkippingMessages(filePath, contents)
		Logger.warn(
			`[Task History] Skipped ${skippedMessages} unreadable message${skippedMessages === 1 ? "" : "s"} in ${filePath}`,
		)
	}
	return readableMessages
}

async function backupTranscriptBeforeSkippingMessages(filePath: string, contents: string): Promise<void> {
	const extension = path.extname(filePath)
	const baseName = path.basename(filePath, extension)
	const backupPath = path.join(path.dirname(filePath), `${baseName}.unreadable.${Date.now()}${extension}`)
	try {
		await atomicWriteFile(backupPath, contents)
	} catch (error) {
		Logger.warn(
			`[Task History] Failed to back up unreadable messages from ${filePath}; continuing with readable messages`,
			error,
		)
	}
}

const CARD_KINDS = new Set<string>(Object.values(CardKind))
const CARD_STATUSES = new Set<string>(Object.values(CardStatus))
const STEERING_STATUSES = new Set<string>(Object.values(SteeringTranscriptStatus))
const RENDER_TYPES = new Set(["text", "markdown", "diff"])
const CLEANUP_STRATEGIES = new Set(["abandon", "success", "error", "keep_running"])
const ACTION_STYLES = new Set(["default", "danger", "secondary"])
const MESSAGE_ROLES = new Set(["user", "assistant"])
const COMPLETION_TYPES = new Set(["act", "plan"])
const API_CANCEL_REASONS = new Set(["streaming_failed", "user_cancelled", "retries_exhausted"])

function isReadableDiracMessage(value: unknown): value is DiracMessage {
	if (!isRecord(value)) return false
	if (typeof value.id !== "string" || value.id.length === 0) return false
	if (!isFiniteNumber(value.ts)) return false
	if (!isRecord(value.content)) return false

	switch (value.content.type) {
		case DiracMessageType.MARKDOWN:
			return isReadableMarkdown(value.content)
		case DiracMessageType.CARD:
			return isReadableCard(value.content.card)
		case DiracMessageType.API_STATUS:
			return isReadableApiStatus(value.content.status)
		case DiracMessageType.CHECKPOINT:
			return true
		default:
			return false
	}
}

function isReadableMarkdown(content: Record<string, unknown>): boolean {
	return (
		typeof content.content === "string" &&
		isOptional(content.isReasoning, isBoolean) &&
		isOptional(content.images, isStringArray) &&
		isOptional(content.files, isStringArray) &&
		isOptional(content.isCompletion, isBoolean) &&
		isOptional(content.completionType, (value) => isStringInSet(value, COMPLETION_TYPES)) &&
		isOptional(content.showFeedback, isBoolean) &&
		isOptional(content.role, (value) => isStringInSet(value, MESSAGE_ROLES)) &&
		isOptional(content.agentId, isFiniteNumber) &&
		isOptional(content.agentName, isString) &&
		isOptional(content.steering, isReadableSteeringState)
	)
}

function isReadableSteeringState(value: unknown): boolean {
	return isRecord(value) && isStringInSet(value.status, STEERING_STATUSES)
}

function isReadableApiStatus(value: unknown): boolean {
	if (!isRecord(value)) return false
	return (
		isOptional(value.id, isString) &&
		isOptional(value.request, isString) &&
		isOptional(value.tokensIn, isFiniteNumber) &&
		isOptional(value.tokensOut, isFiniteNumber) &&
		isOptional(value.cacheWrites, isFiniteNumber) &&
		isOptional(value.reasoningTokens, isFiniteNumber) &&
		isOptional(value.cacheReads, isFiniteNumber) &&
		isOptional(value.cost, isFiniteNumber) &&
		isOptional(value.usageAvailability, isReadableUsageAvailability) &&
		isOptional(value.contextWindow, isFiniteNumber) &&
		isOptional(value.contextUsagePercentage, isFiniteNumber) &&
		isOptional(value.deletedMetrics, isReadableDeletedMetrics) &&
		isOptional(value.cancelReason, (reason) => isStringInSet(reason, API_CANCEL_REASONS)) &&
		isOptional(value.streamingFailedMessage, isString) &&
		isOptional(value.stopReason, isString) &&
		isOptional(value.retryStatus, isReadableRetryStatus)
	)
}

function isReadableUsageAvailability(value: unknown): boolean {
	if (!isRecord(value)) return false
	return (
		isBoolean(value.inputTokens) &&
		isBoolean(value.outputTokens) &&
		isBoolean(value.reasoningTokens) &&
		isBoolean(value.cacheWrites) &&
		isBoolean(value.cacheReads) &&
		isBoolean(value.cost)
	)
}

function isReadableDeletedMetrics(value: unknown): boolean {
	if (!isRecord(value)) return false
	return (
		isOptional(value.tokensIn, isFiniteNumber) &&
		isOptional(value.tokensOut, isFiniteNumber) &&
		isOptional(value.cacheWrites, isFiniteNumber) &&
		isOptional(value.cacheReads, isFiniteNumber)
	)
}

function isReadableRetryStatus(value: unknown): boolean {
	return (
		isRecord(value) &&
		isFiniteNumber(value.attempt) &&
		isFiniteNumber(value.maxAttempts) &&
		isFiniteNumber(value.delaySec) &&
		isOptional(value.errorSnippet, isString)
	)
}

function isReadableCard(value: unknown): boolean {
	if (!isRecord(value)) return false
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.header === "string" &&
		isStringInSet(value.status, CARD_STATUSES) &&
		isStringInSet(value.renderType, RENDER_TYPES) &&
		isOptional(value.kind, (kind) => isStringInSet(kind, CARD_KINDS)) &&
		isOptional(value.toolName, isString) &&
		isOptional(value.body, isString) &&
		isOptional(value.icon, isString) &&
		isOptional(value.rawInput, isRecord) &&
		isOptional(value.rawOutput, isRecord) &&
		isOptional(value.diffs, isReadableCardDiffs) &&
		isOptional(value.locations, isReadableCardLocations) &&
		isOptional(value.requireApproval, isBoolean) &&
		isOptional(value.requireFeedback, isBoolean) &&
		isOptional(value.feedbackPlaceholder, isString) &&
		isOptional(value.actions, isReadableCardActions) &&
		isOptional(value.autoScroll, isBoolean) &&
		isOptional(value.collapsed, isBoolean) &&
		isOptional(value.maxHeight, isFiniteNumber) &&
		isOptional(value.cleanupStrategy, (strategy) => isStringInSet(strategy, CLEANUP_STRATEGIES)) &&
		isOptional(value.do_not_auto_collapse, isBoolean) &&
		isOptional(value.startTime, isFiniteNumber) &&
		isOptional(value.endTime, isFiniteNumber) &&
		isOptional(value.outcome, isString)
	)
}

function isReadableCardActions(value: unknown): boolean {
	return Array.isArray(value) && value.every(isReadableCardAction)
}

function isReadableCardAction(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.label === "string" &&
		typeof value.value === "string" &&
		isOptional(value.primary, isBoolean) &&
		isOptional(value.style, (style) => isStringInSet(style, ACTION_STYLES)) &&
		isOptional(value.url, isString)
	)
}

function isReadableCardLocations(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(location) => isRecord(location) && typeof location.path === "string" && isOptional(location.line, isFiniteNumber),
		)
	)
}

function isReadableCardDiffs(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every(
			(diff) =>
				isRecord(diff) &&
				typeof diff.path === "string" &&
				typeof diff.oldText === "string" &&
				typeof diff.newText === "string",
		)
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isOptional(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
	return value === undefined || predicate(value)
}

function isString(value: unknown): value is string {
	return typeof value === "string"
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean"
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString)
}

function isStringInSet(value: unknown, values: ReadonlySet<string>): boolean {
	return typeof value === "string" && values.has(value)
}

// Persists Dirac UI messages for a task.
export async function saveDiracMessages(taskId: string, uiMessages: DiracMessage[]) {
	try {
		const taskDir = await ensureTaskDirectoryExists(taskId)
		const usesIncrementalStorage =
			(await fileExistsAtPath(path.join(taskDir, GlobalFileNames.uiMessagesBaseline))) ||
			(await fileExistsAtPath(path.join(taskDir, GlobalFileNames.uiMessageOperations)))
		if (usesIncrementalStorage) {
			const current = await getSavedPresentationHistory(taskId)
			await appendPresentationOperations(taskId, [
				{
					offset: current.lastOffset + 1,
					type: "reset",
					messages: uiMessages,
				},
			])
			return
		}
		const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
		await atomicWriteFile(filePath, JSON.stringify(uiMessages))
	} catch (error) {
		Logger.error("Failed to save ui messages:", error)
		throw error
	}
}
