/**
 * Backfill utility for syncing existing task data to S3/R2 storage.
 *
 * This module provides functions to backfill historic task data that was
 * created before S3 storage was configured, or to re-sync data after
 * configuration changes.
 */

import * as fs from "fs/promises"
import { GlobalFileNames, getSavedApiConversationHistory, getTaskHistoryStateFilePath } from "@/core/storage/disk"
import { Logger } from "@/shared/services/Logger"
import { syncWorker } from "./sync"

/**
 * Result of a backfill operation for a single task.
 */
export interface BackfillTaskResult {
	taskId: string
	success: boolean
	filesQueued: string[]
	error?: string
}

/**
 * Result of a full backfill operation.
 */
export interface BackfillResult {
	totalTasks: number
	successCount: number
	failCount: number
	skippedCount: number
	results: BackfillTaskResult[]
}

/**
 * Options for backfill operations.
 */
export interface BackfillOptions {
	/** Only backfill tasks newer than this timestamp */
	sinceTimestamp?: number
	/** Only backfill these specific task IDs */
	taskIds?: string[]
	/** Callback for progress updates */
	onProgress?: (current: number, total: number, taskId: string) => void
}

/**
 * List all task IDs in the tasks directory.
 */
async function listTaskItems(before?: string, after?: string): Promise<Array<{ id: string; ts: number }>> {
	try {
		const historyFile = await getTaskHistoryStateFilePath()
		// Read the history file to get task json names
		const data = await fs.readFile(historyFile, "utf-8")
		const history = JSON.parse(data) as Array<{ id: string; ts: number }>
		return (
			history
				?.filter((item) => typeof item.id === "string" && typeof item.ts === "number")
				.filter((item) => {
					if (before && item.id >= before) {
						return false
					}
					if (after && item.id <= after) {
						return false
					}
					return true
				}) || []
		)
	} catch {
		return []
	}
}

/**
 * Backfill a single task's data to S3/R2.
 *
 * @param taskId Task identifier
 */
export async function backfillTask(taskId: string): Promise<BackfillTaskResult> {
	const result: BackfillTaskResult = {
		taskId,
		success: false,
		filesQueued: [],
	}

	try {
		const queue = syncWorker().getSyncQueue()
		if (!queue) {
			result.error = "S3 storage not configured"
			return result
		}
		const existingItem = queue.getItem(taskId, GlobalFileNames.apiConversationHistory)
		if (existingItem?.status === "synced") {
			// Already synced, skip
			return result
		}
		try {
			const data = await getSavedApiConversationHistory(taskId)
			queue.enqueue(taskId, GlobalFileNames.apiConversationHistory, JSON.stringify(data))
			result.filesQueued.push(taskId)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.error(`Failed to queue ${taskId}:`, err)
			}
			// Skip missing files silently
		}

		result.success = result.filesQueued.length > 0
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err)
	}

	return result
}

/**
 * Backfill all existing tasks to S3/R2 storage.
 *
 * @param options Backfill options
 */
export async function backfillTasks(options: BackfillOptions = {}): Promise<BackfillResult | undefined> {
	const currentTime = Date.now() // Don't backfill tasks created during this operation as they are synced live
	const { sinceTimestamp, taskIds: specificTaskIds, onProgress } = options

	if (!syncWorker().getSyncQueue()) {
		return undefined
	}

	// Get list of tasks to process
	let taskItems: Array<{ id: string; ts: number }>
	if (specificTaskIds && specificTaskIds.length > 0) {
		// Wrap provided IDs with a sentinel ts so the loop body has a uniform shape;
		// ts=0 means the sinceTimestamp guard never skips them (0 < any real timestamp).
		taskItems = specificTaskIds.map((id) => ({ id, ts: 0 }))
	} else {
		taskItems = await listTaskItems(currentTime.toString(), sinceTimestamp?.toString())
	}

	const result: BackfillResult = {
		totalTasks: taskItems.length,
		successCount: 0,
		failCount: 0,
		skippedCount: 0,
		results: [],
	}

	for (let i = 0; i < taskItems.length; i++) {
		const { id: taskId, ts: taskTs } = taskItems[i]

		// Filter by historyItem.ts so UUID-shaped taskIds are handled correctly.
		if (sinceTimestamp && taskTs < sinceTimestamp) {
			result.skippedCount++
			continue
		}

		// Report progress
		if (onProgress) {
			onProgress(i + 1, taskItems.length, taskId)
		}

		// Backfill the task
		const taskResult = await backfillTask(taskId)
		result.results.push(taskResult)

		if (taskResult.success) {
			result.successCount++
		} else if (taskResult.error) {
			result.failCount++
		} else {
			result.skippedCount++
		}
	}

	return result
}
