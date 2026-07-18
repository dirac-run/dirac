import { TaskMetadata } from "@core/context/context-tracking/ContextTrackerTypes"
import { GlobalState, Settings } from "@shared/storage/state-keys"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import Mutex from "p-mutex"
import { Logger } from "@/shared/services/Logger"
import { GlobalFileNames } from "./fileNames"
import { ensureTaskDirectoryExists } from "./directoryEnsurers"

const taskMetadataLocks = new Map<string, Mutex>()

function getTaskMetadataLock(taskId: string): Mutex {
	let lock = taskMetadataLocks.get(taskId)
	if (!lock) {
		lock = new Mutex()
		taskMetadataLocks.set(taskId, lock)
	}
	return lock
}

// Reads task metadata for a task, returning an empty default if absent or unreadable.
export async function getTaskMetadata(taskId: string): Promise<TaskMetadata> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.taskMetadata)
	try {
		if (await fileExistsAtPath(filePath)) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
	} catch (error) {
		Logger.error("Failed to read task metadata:", error)
	}
	return { files_in_context: [], model_usage: [], environment_history: [] }
}

async function writeTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void> {
	const taskDir = await ensureTaskDirectoryExists(taskId)
	const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
	await fs.writeFile(filePath, JSON.stringify(metadata, null, 2))
}

// Persists task metadata for a task.
export async function saveTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void> {
	try {
		await getTaskMetadataLock(taskId).withLock(() => writeTaskMetadata(taskId, metadata))
	} catch (error) {
		Logger.error("Failed to save task metadata:", error)
	}
}

/** Atomically reads, mutates, and persists task metadata for one task. */
export async function updateTaskMetadata(
	taskId: string,
	update: (metadata: TaskMetadata) => void | Promise<void>,
): Promise<TaskMetadata> {
	return getTaskMetadataLock(taskId).withLock(async () => {
		const metadata = await getTaskMetadata(taskId)
		await update(metadata)
		await writeTaskMetadata(taskId, metadata)
		return metadata
	})
}

// Reads per-task settings from storage, returning {} for a new task.
export async function readTaskSettingsFromStorage(taskId: string): Promise<Partial<GlobalState>> {
	try {
		const taskDirectoryFilePath = await ensureTaskDirectoryExists(taskId)
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
export async function writeTaskSettingsToStorage(taskId: string, settings: Partial<Settings>) {
	try {
		const taskDirectoryFilePath = await ensureTaskDirectoryExists(taskId)
		const settingsFilePath = path.join(taskDirectoryFilePath, "settings.json")
		let existingSettings = {}
		if (await fileExistsAtPath(settingsFilePath)) {
			const existingSettingsContent = await fs.readFile(settingsFilePath, "utf8")
			existingSettings = JSON.parse(existingSettingsContent)
		}
		const updatedSettings = { ...existingSettings, ...settings }
		await fs.writeFile(settingsFilePath, JSON.stringify(updatedSettings, null, 2))
	} catch (error) {
		Logger.error("[Disk] Failed to write task settings:", error)
		throw error
	}
}
