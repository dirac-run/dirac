import { initialGoalDisplayText, reconstructTaskHistoryItem } from "./reconstructTaskHistory"
import { createGoalHistoryItem } from "@core/goal/GoalHistory"
import { GoalStore } from "@core/goal/GoalStore"
import type { StateManager } from "@core/storage/StateManager"
import { getSavedDiracMessages, getTaskDirectoryPath, listTaskDirectoryIds } from "@core/storage/disk"
import type { RunHistoryItem } from "@shared/HistoryItem"
import { fileExistsAtPath } from "@utils/fs"
import { getErrorMessage } from "@/shared/errors"
import { Logger } from "@/shared/services/Logger"
import { tryAcquireTaskHistoryInventoryLease } from "@core/storage/taskHistory"

const STANDALONE_TIMESTAMP_ID = /^\d{13}$/
const STANDALONE_UUID_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const RECONSTRUCTION_WORKERS = 4

export interface TaskHistoryRepairResult {
	status: "completed" | "skipped"
	recovered: number
	skipped: number
	errors: number
}

export async function repairMissingTaskHistory(stateManager: StateManager): Promise<TaskHistoryRepairResult> {
	const release = await tryAcquireTaskHistoryInventoryLease()
	if (!release) {
		Logger.info("[Task History Repair] Another Dirac instance owns the repair lease; skipping this scan")
		return { status: "skipped", recovered: 0, skipped: 0, errors: 0 }
	}

	try {
		return await repairMissingTaskHistoryWithLease(stateManager)
	} finally {
		await release()
	}
}

async function repairMissingTaskHistoryWithLease(stateManager: StateManager): Promise<TaskHistoryRepairResult> {
	const taskIds = await listTaskDirectoryIds()
	const existingIds = new Set(stateManager.getGlobalStateKey("taskHistory").map((item) => item.id))
	const goalInventory = await new GoalStore().scanRecords()
	const goalOwnedDirectoryIds = new Set(goalInventory.ownedDirectoryIds)
	for (const { goalId, error } of goalInventory.failures) {
		Logger.warn(`[Task History Repair] Could not read Goal record ${goalId}: ${getErrorMessage(error)}`)
	}
	const recovered: RunHistoryItem[] = []
	let skipped = 0
	let errors = goalInventory.failures.length

	for (const goal of goalInventory.records) {
		if (existingIds.has(goal.id)) continue
		try {
			const messages = await getSavedDiracMessages(goal.id)
			recovered.push(createGoalHistoryItem(goal, initialGoalDisplayText(messages, goal.objective.markdown)))
		} catch (error) {
			errors++
			Logger.warn(`[Task History Repair] Could not reconstruct Goal ${goal.id}: ${getErrorMessage(error)}`)
		}
	}

	const ordinaryCandidateIds = taskIds.filter((taskId) => {
		if (existingIds.has(taskId)) return false
		if (goalOwnedDirectoryIds.has(taskId)) return false
		if (isStandaloneTaskId(taskId)) return true
		skipped++
		return false
	})
	const ordinaryResult = await reconstructOrdinaryTasks(ordinaryCandidateIds, goalOwnedDirectoryIds)
	recovered.push(...ordinaryResult.items)
	skipped += ordinaryResult.skipped
	errors += ordinaryResult.errors

	const existingDirectories = await filterExistingRunDirectories(recovered)
	if (existingDirectories.length > 0) {
		stateManager.insertMissingTaskHistoryItems(existingDirectories)
		await stateManager.flushPendingState()
	}

	Logger.info(`[Task History Repair] Completed: recovered ${existingDirectories.length}, skipped ${skipped}, errors ${errors}`)
	return { status: "completed", recovered: existingDirectories.length, skipped, errors }
}

async function reconstructOrdinaryTasks(
	taskIds: string[],
	goalOwnedDirectoryIds: ReadonlySet<string>,
): Promise<{ items: RunHistoryItem[]; skipped: number; errors: number }> {
	const items: RunHistoryItem[] = []
	let skipped = 0
	let errors = 0
	let nextIndex = 0
	const workers = Array.from({ length: Math.min(RECONSTRUCTION_WORKERS, taskIds.length) }, async () => {
		while (nextIndex < taskIds.length) {
			const taskId = taskIds[nextIndex++]
			try {
				const item = await reconstructTaskHistoryItem(taskId, goalOwnedDirectoryIds)
				if (item) items.push(item)
				else skipped++
			} catch (error) {
				errors++
				Logger.warn(`[Task History Repair] Could not reconstruct Task ${taskId}: ${getErrorMessage(error)}`)
			}
		}
	})
	await Promise.all(workers)
	return { items, skipped, errors }
}

async function filterExistingRunDirectories(items: RunHistoryItem[]): Promise<RunHistoryItem[]> {
	const checks = await Promise.all(
		items.map(async (item) => ({ item, exists: await fileExistsAtPath(getTaskDirectoryPath(item.id)) })),
	)
	return checks.filter(({ exists }) => exists).map(({ item }) => item)
}

function isStandaloneTaskId(taskId: string): boolean {
	return STANDALONE_TIMESTAMP_ID.test(taskId) || STANDALONE_UUID_ID.test(taskId)
}
