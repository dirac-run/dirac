import { HistoryItem } from "@shared/HistoryItem"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { reconstructTaskHistory } from "../commands/reconstructTaskHistory"
import { atomicWriteFile } from "./atomicWrite"
import { ensureStateDirectoryExists } from "./directoryEnsurers"

// Returns the path to the task history state file.
export async function getTaskHistoryStateFilePath(): Promise<string> {
	return path.join(await ensureStateDirectoryExists(), "taskHistory.json")
}

// Returns whether the task history state file exists.
export async function taskHistoryStateFileExists(): Promise<boolean> {
	const filePath = await getTaskHistoryStateFilePath()
	return fileExistsAtPath(filePath)
}

// Reads task history from state, attempting recovery on parse failure.
export async function readTaskHistoryFromState(): Promise<HistoryItem[]> {
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

// Parses task history contents, attempting recovery on parse failure.
async function parseTaskHistoryContents(filePath: string, contents: string): Promise<HistoryItem[]> {
	try {
		return JSON.parse(contents)
	} catch (parseError) {
		telemetryService.captureExtensionStorageError(parseError, "parseError_attemptingRecovery")
		return recoverTaskHistory(filePath)
	}
}

// Attempts to reconstruct task history after a parse error; returns empty array if recovery fails.
async function recoverTaskHistory(filePath: string): Promise<HistoryItem[]> {
	const result = await reconstructTaskHistory(false)
	if (!result || result.reconstructedTasks === 0) {
		return []
	}
	const newContents = await fs.readFile(filePath, "utf8")
	return JSON.parse(newContents)
}

// Atomically writes task history items to the state file.
export async function writeTaskHistoryToState(items: HistoryItem[]): Promise<void> {
	try {
		const filePath = await getTaskHistoryStateFilePath()
		await atomicWriteFile(filePath, JSON.stringify(items))
	} catch (error) {
		Logger.error("[Disk] Failed to write task history:", error)
		throw error
	}
}
