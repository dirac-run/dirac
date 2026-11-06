import { TaskMetadata } from "@core/context/context-tracking/ContextTrackerTypes"
import type { TaskletRecord, TaskletEvent } from "@core/task/types/tasklet"
import { isTaskletUsageSnapshot } from "@shared/taskletUsage"
import { GlobalState, Settings } from "@shared/storage/state-keys"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import Mutex from "p-mutex"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { atomicWriteFile } from "./atomicWrite"
import { ensureTaskDirectoryExists } from "./directoryEnsurers"
import { GlobalFileNames } from "./fileNames"
import { getTaskDirectoryPath, type TaskStorageAddress } from "./taskDirectory"

export type { TaskletRecord, TaskletEvent } from "@core/task/types/tasklet"

/** Read only the owning root's contained records; reconstruction never starts executions. */
export async function loadTaskletRecords(rootTaskId: string): Promise<TaskletRecord[]> {
	return readTaskletRecords(rootTaskId, rootTaskId)
}

/** Rebind only the copied snapshot, never an earlier read of children still writing in the source. */
export async function rebindCopiedTaskletRecords(sourceRootTaskId: string, destinationRootTaskId: string): Promise<void> {
	const records = await readTaskletRecords(destinationRootTaskId, sourceRootTaskId)
	for (const record of records) {
		await saveTaskletRecord({ ...record, rootTaskId: destinationRootTaskId })
	}
}

async function readTaskletRecords(rootTaskId: string, recordRootTaskId: string): Promise<TaskletRecord[]> {
	const collectionDirectory = path.join(getTaskDirectoryPath(rootTaskId), "tasklets")
	let entries: import("fs").Dirent[]
	try {
		entries = await fs.readdir(collectionDirectory, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	return Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const address = { kind: "tasklet" as const, rootTaskId, taskletId: entry.name }
				const record: TaskletRecord = JSON.parse(
					await fs.readFile(path.join(getTaskDirectoryPath(address), GlobalFileNames.taskletRecord), "utf8"),
				)
				if (
					!record ||
					record.id !== entry.name ||
					record.rootTaskId !== recordRootTaskId ||
					typeof record.conversationUlid !== "string" ||
					!record.conversationUlid ||
					typeof record.title !== "string" ||
					typeof record.prompt !== "string" ||
					!Number.isFinite(record.createdAt) ||
					(record.inheritedMessageCount !== undefined &&
						(!Number.isSafeInteger(record.inheritedMessageCount) || record.inheritedMessageCount < 0)) ||
					(record.purpose !== undefined && record.purpose !== "goal_verification") ||
					(record.usage !== undefined && !isTaskletUsageSnapshot(record.usage))
				)
					throw new Error(`Invalid tasklet record for ${entry.name} under root ${rootTaskId}`)
				return record
			}),
	)
}

/** Retain full communication and delivery state; missing pre-communication snapshots are empty. */
export async function loadTaskletEvents(address: Extract<TaskStorageAddress, { kind: "tasklet" }>): Promise<TaskletEvent[]> {
	const filePath = path.join(getTaskDirectoryPath(address), GlobalFileNames.taskletEvents)
	let contents: string
	try {
		contents = await fs.readFile(filePath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	const events: TaskletEvent[] = JSON.parse(contents)
	if (
		!Array.isArray(events) ||
		events.some(
			(event) =>
				!event ||
				typeof event.id !== "string" ||
				!event.id ||
				event.taskletId !== address.taskletId ||
				!Number.isFinite(event.createdAt) ||
				(event.deliveredAt !== undefined && !Number.isFinite(event.deliveredAt)) ||
				!event.communication ||
				(event.communication.type === "message"
					? !event.communication.message ||
						event.communication.message.taskletId !== address.taskletId ||
						!["guidance", "question", "reply", "permission_decision"].includes(event.communication.message.type)
					: false) ||
				(event.communication.type === "response"
					? !event.communication.response || typeof event.communication.response !== "object"
					: event.communication.type === "outcome"
						? !event.communication.outcome ||
							!["completed", "failed", "cancelled", "interrupted"].includes(event.communication.outcome.kind)
						: event.communication.type === "message"
							? false
							: event.communication.type === "lifecycle"
								? !["accepted", "resumed"].includes(event.communication.state)
								: event.communication.type !== "interaction" ||
									!event.communication.request ||
									typeof event.communication.request.id !== "string" ||
									!["pending", "resolved", "retired"].includes(event.communication.request.status)),
		)
	)
		throw new Error(`Invalid tasklet events for ${address.taskletId} under root ${address.rootTaskId}`)
	return events
}

/** TaskletHost is the sole writer; it serializes acceptance before outcome publication. */
export async function saveTaskletRecord(record: TaskletRecord): Promise<void> {
	const directory = await ensureTaskDirectoryExists({
		kind: "tasklet",
		rootTaskId: record.rootTaskId,
		taskletId: record.id,
	})
	await atomicWriteFile(path.join(directory, GlobalFileNames.taskletRecord), JSON.stringify(record, null, 2))
}

/** The owning host serializes full communication snapshots and delivery acknowledgements. */
export async function saveTaskletEvents(
	address: Extract<TaskStorageAddress, { kind: "tasklet" }>,
	events: readonly TaskletEvent[],
): Promise<void> {
	const directory = await ensureTaskDirectoryExists(address)
	await atomicWriteFile(path.join(directory, GlobalFileNames.taskletEvents), JSON.stringify(events, null, 2))
}

// Process-local locks only; address resolution is not ownership authorization or filesystem isolation.
const taskMetadataLocks = new Map<string, Mutex>()
const taskSettingsLocks = new Map<string, Mutex>()

function getTaskMetadataLock(taskDirectory: string): Mutex {
	let lock = taskMetadataLocks.get(taskDirectory)
	if (!lock) {
		lock = new Mutex()
		taskMetadataLocks.set(taskDirectory, lock)
	}
	return lock
}

function getTaskSettingsLock(taskDirectory: string): Mutex {
	let lock = taskSettingsLocks.get(taskDirectory)
	if (!lock) {
		lock = new Mutex()
		taskSettingsLocks.set(taskDirectory, lock)
	}
	return lock
}

// Reads task metadata for a task, returning an empty default if absent or unreadable.
export async function getTaskMetadata(address: string | TaskStorageAddress): Promise<TaskMetadata> {
	const filePath = path.join(await ensureTaskDirectoryExists(address), GlobalFileNames.taskMetadata)
	try {
		if (await fileExistsAtPath(filePath)) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
	} catch (error) {
		Logger.error("Failed to read task metadata:", error)
	}
	return { files_in_context: [], model_usage: [], environment_history: [] }
}

async function writeTaskMetadata(address: string | TaskStorageAddress, metadata: TaskMetadata): Promise<void> {
	const taskDir = await ensureTaskDirectoryExists(address)
	const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
	await atomicWriteFile(filePath, JSON.stringify(metadata, null, 2))
}

// Legacy best-effort save: logs failures without rejecting; use updateTaskMetadata for propagating failures.
export async function saveTaskMetadata(address: string | TaskStorageAddress, metadata: TaskMetadata): Promise<void> {
	try {
		await getTaskMetadataLock(getTaskDirectoryPath(address)).withLock(() => writeTaskMetadata(address, metadata))
	} catch (error) {
		Logger.error("Failed to save task metadata:", error)
	}
}

/** Atomically reads, mutates, and persists task metadata for one task. */
export async function updateTaskMetadata(
	address: string | TaskStorageAddress,
	update: (metadata: TaskMetadata) => void | Promise<void>,
): Promise<TaskMetadata> {
	return getTaskMetadataLock(getTaskDirectoryPath(address)).withLock(async () => {
		const metadata = await getTaskMetadata(address)
		await update(metadata)
		await writeTaskMetadata(address, metadata)
		return metadata
	})
}

// Reads per-task settings from storage, returning {} for a new task.
export async function readTaskSettingsFromStorage(address: string | TaskStorageAddress): Promise<Partial<GlobalState>> {
	try {
		const taskDirectoryFilePath = await ensureTaskDirectoryExists(address)
		const settingsFilePath = path.join(taskDirectoryFilePath, "settings.json")
		if (await fileExistsAtPath(settingsFilePath)) {
			const settingsContent = await fs.readFile(settingsFilePath, "utf8")
			return JSON.parse(settingsContent)
		}
		return {}
	} catch (error) {
		Logger.error("[Disk] Failed to read task settings:", error)
		throw error
	}
}

// Merges and persists per-task settings into the task's settings.json.
export async function writeTaskSettingsToStorage(address: string | TaskStorageAddress, settings: Partial<Settings>) {
	try {
		await getTaskSettingsLock(getTaskDirectoryPath(address)).withLock(async () => {
			const taskDirectoryFilePath = await ensureTaskDirectoryExists(address)
			const settingsFilePath = path.join(taskDirectoryFilePath, "settings.json")
			let existingSettings = {}
			if (await fileExistsAtPath(settingsFilePath)) {
				const existingSettingsContent = await fs.readFile(settingsFilePath, "utf8")
				existingSettings = JSON.parse(existingSettingsContent)
			}
			const updatedSettings = { ...existingSettings, ...settings }
			await atomicWriteFile(settingsFilePath, JSON.stringify(updatedSettings, null, 2))
		})
	} catch (error) {
		Logger.error("[Disk] Failed to write task settings:", error)
		throw error
	}
}
