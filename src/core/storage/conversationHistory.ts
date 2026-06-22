import { Anthropic } from "@anthropic-ai/sdk"
import { DiracMessage } from "@shared/ExtensionMessage"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { syncWorker } from "@/shared/services/worker/sync"
import { GlobalFileNames } from "./fileNames"
import { atomicWriteFile } from "./atomicWrite"
import { ensureTaskDirectoryExists } from "./directoryEnsurers"

// Reads the saved API conversation history for a task, returning [] if absent.
export async function getSavedApiConversationHistory(taskId: string): Promise<Anthropic.MessageParam[]> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.apiConversationHistory)
	const fileExists = await fileExistsAtPath(filePath)
	if (fileExists) {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	}
	return []
}

// Persists API conversation history for a task, queuing remote sync without blocking.
export async function saveApiConversationHistory(taskId: string, apiConversationHistory: Anthropic.MessageParam[]) {
	if (apiConversationHistory.length === 0) {
		return
	}
	try {
		const fileName = GlobalFileNames.apiConversationHistory
		const data = JSON.stringify(apiConversationHistory)
		syncWorker().enqueue(taskId, fileName, data)
		const filePath = path.join(await ensureTaskDirectoryExists(taskId), fileName)
		await atomicWriteFile(filePath, data)
	} catch (error) {
		Logger.error("Failed to save API conversation history:", error)
	}
}

// Reads saved Dirac UI messages for a task, migrating from the legacy claude_messages.json location.
export async function getSavedDiracMessages(taskId: string): Promise<DiracMessage[]> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.uiMessages)
	if (await fileExistsAtPath(filePath)) {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	}
	// check old location
	const oldPath = path.join(await ensureTaskDirectoryExists(taskId), "claude_messages.json")
	if (await fileExistsAtPath(oldPath)) {
		const data = JSON.parse(await fs.readFile(oldPath, "utf8"))
		await fs.unlink(oldPath) // remove old file
		return data
	}
	return []
}

// Persists Dirac UI messages for a task.
export async function saveDiracMessages(taskId: string, uiMessages: DiracMessage[]) {
	try {
		const taskDir = await ensureTaskDirectoryExists(taskId)
		const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
		await atomicWriteFile(filePath, JSON.stringify(uiMessages))
	} catch (error) {
		Logger.error("Failed to save ui messages:", error)
	}
}
