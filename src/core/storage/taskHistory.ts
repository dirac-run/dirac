import { assertGoalAccounting } from "@core/goal/validateGoalRecord"
import type { GoalHistoryItem, RunHistoryItem, TaskHistoryItem } from "@shared/HistoryItem"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import { lock, type LockOptions, type ReleaseLock } from "proper-lockfile"
import Mutex from "p-mutex"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { TASKLET_ID_PREFIX } from "@/shared/taskletId"
import { reconstructTaskHistory } from "../commands/reconstructTaskHistory"
import { atomicWriteFile } from "./atomicWrite"
import { ensureStateDirectoryExists } from "./directoryEnsurers"

const GOAL_STATUSES = new Set(["working", "waiting", "paused", "blocked", "achieved", "stopped"])
const WRITE_LOCK_OPTIONS: LockOptions = {
	realpath: false,
	stale: 10_000,
	update: 2_000,
	retries: { retries: 20, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
}
const INVENTORY_LOCK_OPTIONS: LockOptions = {
	realpath: false,
	stale: 30_000,
	update: 5_000,
	retries: { retries: 40, factor: 1.15, minTimeout: 50, maxTimeout: 500 },
}
const taskHistoryWriteMutex = new Mutex()

export type TaskHistoryMutation =
	| { kind: "upsert"; item: RunHistoryItem }
	| { kind: "setFavorite"; id: string; isFavorited: boolean }
	| { kind: "remove"; ids: string[] }
	| { kind: "insertMissing"; items: RunHistoryItem[] }
	| { kind: "replace"; items: RunHistoryItem[] }

// Returns the path to the task history state file.
export async function getTaskHistoryStateFilePath(): Promise<string> {
	return path.join(await ensureStateDirectoryExists(), "taskHistory.json")
}

// Returns whether the task history state file exists.
export async function taskHistoryStateFileExists(): Promise<boolean> {
	const filePath = await getTaskHistoryStateFilePath()
	return fileExistsAtPath(filePath)
}

async function getTaskHistoryInventoryLockPath(): Promise<string> {
	return path.join(await ensureStateDirectoryExists(), "taskHistory.inventory")
}

export async function tryAcquireTaskHistoryInventoryLease(): Promise<ReleaseLock | undefined> {
	try {
		return await lock(await getTaskHistoryInventoryLockPath(), {
			...INVENTORY_LOCK_OPTIONS,
			retries: 0,
		})
	} catch (error) {
		if (isLockContentionError(error)) return undefined
		throw error
	}
}

export async function withTaskHistoryInventoryLock<T>(operation: () => Promise<T>): Promise<T> {
	const release = await lock(await getTaskHistoryInventoryLockPath(), INVENTORY_LOCK_OPTIONS)
	try {
		return await operation()
	} finally {
		await release()
	}
}

// Reads task history from state, attempting recovery on parse failure.
export async function readTaskHistoryFromState(): Promise<RunHistoryItem[]> {
	try {
		const filePath = await getTaskHistoryStateFilePath()
		if (!(await fileExistsAtPath(filePath))) {
			return []
		}
		const contents = await fs.readFile(filePath, "utf8")
		return parseTaskHistoryContents(filePath, contents)
	} catch (error) {
		telemetryService.captureExtensionStorageError(error, "readTaskHistoryFromState")
		throw error
	}
}

// Parses task history contents, recovering an invalid root and skipping invalid records.
async function parseTaskHistoryContents(filePath: string, contents: string): Promise<RunHistoryItem[]> {
	let parsed: unknown
	try {
		parsed = JSON.parse(contents)
	} catch (parseError) {
		telemetryService.captureExtensionStorageError(parseError, "parseError_attemptingRecovery")
		return recoverTaskHistory(filePath, contents)
	}

	if (!Array.isArray(parsed)) {
		const rootError = new Error("Task history root is not an array")
		telemetryService.captureExtensionStorageError(rootError.message, "invalidRoot_attemptingRecovery")
		return recoverTaskHistory(filePath, contents)
	}

	const historyItems: RunHistoryItem[] = []
	for (const [index, item] of parsed.entries()) {
		if (hasTaskletHistoryId(item)) continue
		if (isExplicitGoalRecord(item)) {
			assertReadableGoalHistoryItem(item, index)
			historyItems.push(item)
			continue
		}
		if (hasUnsupportedRunKind(item)) throw new Error(`History entry ${index} has an unsupported run kind`)
		if (isReadableTaskHistoryItem(item)) historyItems.push(item)
	}
	const skippedItems = parsed.length - historyItems.length
	if (parsed.length > 0 && historyItems.length === 0) {
		const recordsError = new Error("Task history contains no readable records")
		telemetryService.captureExtensionStorageError(recordsError.message, "invalidRecords_attemptingRecovery")
		return recoverTaskHistory(filePath, contents)
	}
	if (skippedItems > 0) {
		Logger.warn(`[Task History] Skipped ${skippedItems} unreadable entr${skippedItems === 1 ? "y" : "ies"}`)
	}
	return historyItems
}

function hasTaskletHistoryId(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const id = (value as Record<string, unknown>).id
	return typeof id === "string" && id.startsWith(TASKLET_ID_PREFIX)
}

function isExplicitGoalRecord(value: unknown): value is Record<string, unknown> & { runKind: "goal" } {
	return !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).runKind === "goal"
}

function hasUnsupportedRunKind(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const runKind = (value as Record<string, unknown>).runKind
	return runKind !== undefined && runKind !== "task" && runKind !== "goal"
}

function hasReadableHistoryBase(item: Record<string, unknown>): boolean {
	return (
		typeof item.id === "string" &&
		item.id.length > 0 &&
		isFiniteNumber(item.ts) &&
		typeof item.task === "string" &&
		isOptional(item.tokensIn, isFiniteNumber) &&
		isOptional(item.tokensOut, isFiniteNumber) &&
		isOptional(item.cacheWrites, isFiniteNumber) &&
		isOptional(item.cacheReads, isFiniteNumber) &&
		isOptional(item.totalCost, isFiniteNumber) &&
		isOptional(item.size, isFiniteNumber) &&
		isOptional(item.ulid, isString) &&
		isOptional(item.shadowGitConfigWorkTree, isString) &&
		isOptional(item.cwdOnTaskInitialization, isString) &&
		isOptional(item.workspaceRootPath, isString) &&
		isOptional(item.checkpointManagerErrorMessage, isString) &&
		isOptional(item.modelId, isString) &&
		isOptional(item.isFavorited, isBoolean) &&
		isOptional(item.conversationHistoryDeletedRange, isFiniteNumberPair)
	)
}

function isReadableTaskHistoryItem(value: unknown): value is TaskHistoryItem {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const item = value as Record<string, unknown>
	return (item.runKind === undefined || item.runKind === "task") && hasReadableHistoryBase(item)
}

function assertReadableGoalHistoryItem(
	value: Record<string, unknown>,
	index: number,
): asserts value is Record<string, unknown> & GoalHistoryItem {
	const path = `History entry ${index}`
	if (!hasReadableHistoryBase(value)) throw new Error(`${path} has an invalid common summary`)
	if (typeof value.conversationUlid !== "string" || !value.conversationUlid) {
		throw new Error(`${path} has an invalid conversationUlid`)
	}
	if (typeof value.initialDisplayText !== "string" || !value.initialDisplayText) {
		throw new Error(`${path} has an invalid initialDisplayText`)
	}
	if (value.task !== value.initialDisplayText) throw new Error(`${path} has inconsistent initial display text`)
	if (typeof value.objectivePreview !== "string" || !value.objectivePreview.trim()) {
		throw new Error(`${path} has an invalid objectivePreview`)
	}
	if (!Number.isInteger(value.objectiveRevision) || (value.objectiveRevision as number) <= 0) {
		throw new Error(`${path} has an invalid objectiveRevision`)
	}
	if (typeof value.status !== "string" || !GOAL_STATUSES.has(value.status)) throw new Error(`${path} has an invalid status`)
	if (!isOptional(value.statusReason, isString)) throw new Error(`${path} has an invalid statusReason`)
	if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt) || !isFiniteNumber(value.activeDurationMs)) {
		throw new Error(`${path} has invalid timestamps or active duration`)
	}
	if ((value.createdAt as number) < 0 || (value.updatedAt as number) < (value.createdAt as number)) {
		throw new Error(`${path} has inconsistent timestamps`)
	}
	if ((value.activeDurationMs as number) < 0) throw new Error(`${path} has a negative active duration`)
	assertGoalAccounting(value.accounting, `${path}.accounting`)
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

function isFiniteNumberPair(value: unknown): boolean {
	return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
}

// Attempts to reconstruct task history after a parse error; returns an empty valid index if recovery fails.
async function recoverTaskHistory(filePath: string, unreadableContents: string): Promise<RunHistoryItem[]> {
	await backupUnreadableTaskHistory(filePath, unreadableContents)

	const result = await reconstructTaskHistory(false)
	if (!result || result.reconstructedTasks === 0) {
		await writeTaskHistoryToState([])
		return []
	}

	const newContents = await fs.readFile(filePath, "utf8")
	return parseTaskHistoryContents(filePath, newContents)
}

async function backupUnreadableTaskHistory(filePath: string, contents: string): Promise<void> {
	const backupPath = path.join(path.dirname(filePath), `taskHistory.unreadable.${Date.now()}.json`)
	try {
		await atomicWriteFile(backupPath, contents)
	} catch (error) {
		Logger.warn(`[Task History] Failed to back up unreadable history at ${backupPath}`, error)
	}
}

export function applyTaskHistoryMutations(
	initialItems: RunHistoryItem[],
	mutations: readonly TaskHistoryMutation[],
): RunHistoryItem[] {
	let items = [...initialItems]
	for (const mutation of mutations) {
		switch (mutation.kind) {
			case "upsert": {
				const index = items.findIndex((item) => item.id === mutation.item.id)
				if (index === -1) {
					items.push(mutation.item)
					break
				}
				const existing = items[index]
				assertMatchingRunKinds(existing, mutation.item)
				items[index] = {
					...mutation.item,
					...(existing.isFavorited !== undefined ? { isFavorited: existing.isFavorited } : {}),
				}
				break
			}
			case "setFavorite": {
				const index = items.findIndex((item) => item.id === mutation.id)
				if (index === -1) throw new Error(`Run ${mutation.id} is not present in top-level history`)
				items[index] = { ...items[index], isFavorited: mutation.isFavorited }
				break
			}
			case "remove": {
				const removedIds = new Set(mutation.ids)
				items = items.filter((item) => !removedIds.has(item.id))
				break
			}
			case "insertMissing": {
				const existingIds = new Set(items.map((item) => item.id))
				for (const item of mutation.items) {
					if (existingIds.has(item.id)) continue
					items.push(item)
					existingIds.add(item.id)
				}
				break
			}
			case "replace":
				items = [...mutation.items]
				break
		}
	}
	for (const item of items) {
		if (hasTaskletHistoryId(item)) throw new Error(`Tasklet ${item.id} cannot be persisted in top-level history`)
	}
	return items
}

export async function commitTaskHistoryMutations(
	mutations: readonly TaskHistoryMutation[],
): Promise<RunHistoryItem[]> {
	if (mutations.length === 0) return readTaskHistoryFromState()
	return taskHistoryWriteMutex.withLock(async () => {
		const filePath = await getTaskHistoryStateFilePath()
		const release = await lock(filePath, WRITE_LOCK_OPTIONS)
		try {
			const firstMutation = mutations[0]
			const current = firstMutation.kind === "replace" ? [] : await readTaskHistoryFileWithoutRecovery(filePath)
			const items = applyTaskHistoryMutations(current, mutations)
			assertWritableTaskHistory(items)
			await atomicWriteFile(filePath, JSON.stringify(items))
			return items
		} catch (error) {
			Logger.error("[Task History] Failed to commit mutations:", error)
			throw error
		} finally {
			await release()
		}
	})
}

// Replaces the complete task-history index. Normal callers should use ID-scoped mutations.
export async function writeTaskHistoryToState(items: RunHistoryItem[]): Promise<void> {
	await commitTaskHistoryMutations([{ kind: "replace", items }])
}

async function readTaskHistoryFileWithoutRecovery(filePath: string): Promise<RunHistoryItem[]> {
	if (!(await fileExistsAtPath(filePath))) return []
	const contents = await fs.readFile(filePath, "utf8")
	const parsed: unknown = JSON.parse(contents)
	if (!Array.isArray(parsed)) throw new Error("Task history root is not an array")
	const items: RunHistoryItem[] = []
	for (const [index, item] of parsed.entries()) {
		if (hasTaskletHistoryId(item)) continue
		if (isExplicitGoalRecord(item)) {
			assertReadableGoalHistoryItem(item, index)
			items.push(item)
			continue
		}
		if (hasUnsupportedRunKind(item)) throw new Error(`History entry ${index} has an unsupported run kind`)
		if (isReadableTaskHistoryItem(item)) items.push(item)
	}
	return items
}

function assertWritableTaskHistory(items: RunHistoryItem[]): void {
	const ids = new Set<string>()
	items.forEach((item, index) => {
		if (ids.has(item.id)) throw new Error(`Task history contains duplicate run ${item.id}`)
		ids.add(item.id)
		if (item.runKind === "goal") assertReadableGoalHistoryItem(item as unknown as Record<string, unknown>, index)
		else if (!isReadableTaskHistoryItem(item)) throw new Error(`History entry ${index} is not a readable Task summary`)
	})
}

function assertMatchingRunKinds(existing: RunHistoryItem, replacement: RunHistoryItem): void {
	if ((existing.runKind === "goal") === (replacement.runKind === "goal")) return
	throw new Error(`Run ${existing.id} cannot change between Task and Goal history kinds`)
}

function isLockContentionError(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ELOCKED"
}
