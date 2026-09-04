import {
	getSavedDiracMessages,
	getTaskHistoryStateFilePath,
	getTaskMetadata,
	writeTaskHistoryToState,
} from "@core/storage/disk"
import { createGoalHistoryItem } from "@core/goal/GoalHistory"
import { GoalStore } from "@core/goal/GoalStore"
import type { TaskMetadata } from "@core/context/context-tracking/ContextTrackerTypes"
import { HostProvider } from "@hosts/host-provider"
import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { HistoryItem } from "@shared/HistoryItem"
import { ShowMessageType } from "@shared/proto/host/window"
import { fileExistsAtPath } from "@utils/fs"
import * as path from "path"
import { ulid } from "ulid"
import { getErrorMessage } from "@/shared/errors"
import { Logger } from "@/shared/services/Logger"
import { withTaskHistoryInventoryLock } from "@core/storage/taskHistory"

export interface TaskReconstructionResult {
	totalTasks: number
	reconstructedTasks: number
	skippedTasks: number
	errors: string[]
}

/**
 * Reconstructs task history from existing task folders.
 * Automatic recovery runs without prompting; the command path retains confirmation and notifications.
 * @param showNotifications Whether to show user-facing notifications and dialogs
 * @returns Reconstruction result or null if cancelled or recovery fails
 */
export async function reconstructTaskHistory(showNotifications = true): Promise<TaskReconstructionResult | null> {
	try {
		if (showNotifications) {
			const proceed = await HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message:
					"This will rebuild your task history from existing task data. This operation will backup your current task history and attempt to reconstruct it from task folders. Continue?",
				options: {
					items: ["Yes, Reconstruct", "Cancel"],
				},
			})

			if (proceed?.selectedOption !== "Yes, Reconstruct") {
				return null
			}

			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Reconstructing task history...",
			})
		}

		const result = await withTaskHistoryInventoryLock(() => performTaskHistoryReconstruction())

		if (showNotifications) {
			if (result.errors.length > 0) {
				const errorMessage = `Reconstruction completed with warnings:\n- Reconstructed: ${result.reconstructedTasks} tasks\n- Skipped: ${result.skippedTasks} tasks\n- Errors: ${result.errors.length}\n\nFirst few errors:\n${result.errors.slice(0, 3).join("\n")}`

				HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: errorMessage,
				})
			} else {
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: `Task history successfully reconstructed! Found and restored ${result.reconstructedTasks} tasks.`,
				})
			}
		}

		return result
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		if (showNotifications) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to reconstruct task history: ${errorMessage}`,
			})
		} else {
			Logger.warn(`[Task History] Automatic reconstruction failed: ${errorMessage}`)
		}
		return null
	}
}

async function performTaskHistoryReconstruction(): Promise<TaskReconstructionResult> {
	const result: TaskReconstructionResult = {
		totalTasks: 0,
		reconstructedTasks: 0,
		skippedTasks: 0,
		errors: [],
	}

	// Backup existing task history
	await backupExistingTaskHistory()

	// Get tasks directory
	const tasksDir = path.join(HostProvider.get().globalStorageFsPath, "tasks")

	// Check if tasks directory exists
	if (!(await fileExistsAtPath(tasksDir))) {
		throw new Error("No tasks directory found. Nothing to reconstruct.")
	}

	// Scan for task directories
	const taskIds = await scanTaskDirectories(tasksDir)
	const goals = await new GoalStore().list()
	const goalOwnedDirectoryIds = new Set(goals.flatMap((goal) => [goal.id, ...goal.children.map((child) => child.id)]))
	const ordinaryTaskIds = taskIds.filter((taskId) => !goalOwnedDirectoryIds.has(taskId))
	result.totalTasks = ordinaryTaskIds.length + goals.length

	if (result.totalTasks === 0) {
		throw new Error("No task directories found. Nothing to reconstruct.")
	}

	// Process each task
	const reconstructedItems: HistoryItem[] = []
	for (const goal of goals) {
		const messages = await getSavedDiracMessages(goal.id)
		reconstructedItems.push(createGoalHistoryItem(goal, initialGoalDisplayText(messages, goal.objective.markdown)))
		result.reconstructedTasks++
	}

	for (const taskId of ordinaryTaskIds) {
		try {
			const historyItem = await reconstructTaskHistoryItem(taskId)
			if (historyItem) {
				reconstructedItems.push(historyItem)
				result.reconstructedTasks++
			} else {
				result.skippedTasks++
			}
		} catch (error) {
			result.skippedTasks++
			const errorMsg = getErrorMessage(error)
			result.errors.push(`Task ${taskId}: ${errorMsg}`)
		}
	}

	// Sort by timestamp (newest first)
	reconstructedItems.sort((a, b) => b.ts - a.ts)

	// Write reconstructed history
	await writeTaskHistoryToState(reconstructedItems)

	return result
}

export function initialGoalDisplayText(messages: DiracMessage[], fallback: string): string {
	const initialUserMessage = messages.find(
		(message) =>
			message.content.type === DiracMessageType.MARKDOWN &&
			message.content.role === "user" &&
			message.content.content.trim().length > 0,
	)
	if (!initialUserMessage || initialUserMessage.content.type !== DiracMessageType.MARKDOWN) return fallback
	return initialUserMessage.content.content.trim()
}

async function backupExistingTaskHistory(): Promise<void> {
	try {
		const historyFilePath = await getTaskHistoryStateFilePath()
		if (!(await fileExistsAtPath(historyFilePath))) return

		const fs = await import("fs/promises")
		const contents = await fs.readFile(historyFilePath, "utf8")
		if (contents.length === 0) return

		const backupPath = path.join(path.dirname(historyFilePath), `taskHistory.backup.${Date.now()}.json`)
		await fs.writeFile(backupPath, contents)
	} catch (error) {
		Logger.warn("Failed to backup existing task history:", error)
	}
}

async function scanTaskDirectories(tasksDir: string): Promise<string[]> {
	const fs = await import("fs/promises")

	try {
		const entries = await fs.readdir(tasksDir, { withFileTypes: true })
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	} catch (error) {
		throw new Error(`Failed to scan tasks directory: ${error}`)
	}
}

export async function reconstructTaskHistoryItem(taskId: string): Promise<HistoryItem | null> {
	try {
		// Load UI messages to extract task info
		const diracMessages = await getSavedDiracMessages(taskId)
		if (diracMessages.length === 0) {
			return null // Skip empty tasks
		}

		// Load task metadata for token usage
		const metadata = await getTaskMetadata(taskId)

		// Extract task information
		const taskInfo = extractTaskInformation(diracMessages, metadata)

		// Create HistoryItem
		const historyItem: HistoryItem = {
			id: taskId,
			ulid: taskInfo.ulid || ulid(), // Generate new ULID if missing
			ts: taskInfo.timestamp,
			task: taskInfo.taskDescription,
			tokensIn: taskInfo.tokensIn,
			tokensOut: taskInfo.tokensOut,
			cacheWrites: taskInfo.cacheWrites,
			cacheReads: taskInfo.cacheReads,
			totalCost: taskInfo.totalCost,
			size: taskInfo.size,
			isFavorited: taskInfo.isFavorited,
			conversationHistoryDeletedRange: taskInfo.conversationHistoryDeletedRange,
		}

		return historyItem
	} catch (error) {
		throw new Error(`Failed to reconstruct task ${taskId}: ${error}`)
	}
}

interface TaskInfo {
	ulid?: string
	timestamp: number
	taskDescription: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number
	size?: number
	isFavorited?: boolean
	conversationHistoryDeletedRange?: [number, number]
}

function extractTaskInformation(diracMessages: DiracMessage[], metadata: TaskMetadata): TaskInfo {
	// Find the first user message (task description)
	const firstUserMessage = diracMessages.find(
		(msg) => msg.content.type === DiracMessageType.MARKDOWN && !msg.content.isReasoning && msg.content.content,
	)

	// Extract timestamp from first message or use task ID as fallback
	const timestamp = diracMessages.length > 0 ? diracMessages[0].ts : Date.now()

	// Extract task description
	let taskDescription = "Untitled Task"
	if (firstUserMessage?.content.type === DiracMessageType.MARKDOWN && firstUserMessage.content.content) {
		// Clean up the task description
		const cleanText = firstUserMessage.content.content
			.replace(/<task>\s*/g, "")
			.replace(/\s*<\/task>/g, "")
			.trim()

		const firstLine = cleanText.split("\n")[0]
		if (firstLine) {
			taskDescription = firstLine.substring(0, 100) // Limit length
		}
	}

	// Use the same accounting projection as live sessions, including subagent usage.
	const metrics = getApiMetrics(diracMessages)
	let tokensIn = metrics.totalTokensIn
	let tokensOut = metrics.totalTokensOut
	let cacheWrites = metrics.totalCacheWrites ?? 0
	let cacheReads = metrics.totalCacheReads ?? 0
	let totalCost = metrics.totalCost

	// Use metadata if available and no tokens found in messages
	if (tokensIn === 0 && tokensOut === 0 && metadata.model_usage) {
		for (const usage of metadata.model_usage) {
			tokensIn += usage.tokensIn || 0
			tokensOut += usage.tokensOut || 0
			cacheWrites += usage.cacheWrites || 0
			cacheReads += usage.cacheReads || 0
			totalCost += usage.totalCost || 0
		}
	}

	// Calculate approximate size (rough estimate)
	const messageSize = JSON.stringify(diracMessages).length
	const size = Math.floor(messageSize / 1024) // KB

	return {
		timestamp,
		taskDescription,
		tokensIn,
		tokensOut,
		cacheWrites: cacheWrites > 0 ? cacheWrites : undefined,
		cacheReads: cacheReads > 0 ? cacheReads : undefined,
		totalCost,
		size,
	}
}
