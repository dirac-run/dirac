import { TaskMetadata } from "@core/context/context-tracking/ContextTrackerTypes"
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
