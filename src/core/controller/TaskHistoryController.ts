import type { Anthropic } from "@anthropic-ai/sdk"
import { GoalStore } from "@core/goal/GoalStore"
import {
	deleteTaskDirectory,
	ensureCacheDirectoryExists,
	GlobalFileNames,
	getSavedApiConversationHistory,
	getSavedDiracMessages,
	getTaskDirectoryPath,
} from "@core/storage/disk"
import { isActiveGoalStatus } from "@shared/goal"
import {
	type GoalHistoryItem,
	type HistoryItem,
	isGoalHistoryItem,
	isTaskHistoryItem,
	type RunHistoryItem,
	type TaskHistoryItem,
} from "@shared/HistoryItem"
import { removeLegacySynthetic1mModelEntries } from "@shared/storage/legacy-model-id-migration"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { withTaskHistoryInventoryLock } from "@core/storage/taskHistory"
import { getUserPrompts, type UserPrompt } from "@shared/messages/prompt-history"
import { arePathsEqual } from "@utils/path"

export async function deleteRunStorage(item: RunHistoryItem, goalStore = new GoalStore()): Promise<void> {
	if (!isGoalHistoryItem(item)) {
		await deleteTaskDirectory(item.id)
		return
	}

	const goal = await goalStore.read(item.id)
	if (isActiveGoalStatus(goal.status)) throw new Error(`Goal ${item.id} must be paused or stopped before deletion`)
	await Promise.all(goal.children.map((child) => deleteTaskDirectory(child.id)))
	await deleteTaskDirectory(item.id)
}

export class TaskHistoryController {
	constructor(
		private readonly stateManager: import("@core/storage/StateManager").StateManager,
		private readonly goalStore = new GoalStore(),
	) {}

	async readOpenRouterModels(): Promise<Record<string, import("@shared/api").ModelInfo> | undefined> {
		const openRouterModelsFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)
		try {
			if (await fileExistsAtPath(openRouterModelsFilePath)) {
				const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
				const models = JSON.parse(fileContents)
				return removeLegacySynthetic1mModelEntries(models)
			}
		} catch (error) {
			Logger.error("Error reading cached OpenRouter models:", error)
		}
		return undefined
	}

	async getTaskWithId(id: string): Promise<{
		historyItem: TaskHistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const history = this.stateManager.getGlobalStateKey("taskHistory")
		const runHistoryItem = history.find((item) => item.id === id)
		if (runHistoryItem && isGoalHistoryItem(runHistoryItem)) {
			throw new Error(`Run ${id} is a Goal and cannot be loaded as a Task`)
		}
		const historyItem = runHistoryItem && isTaskHistoryItem(runHistoryItem) ? runHistoryItem : undefined
		if (historyItem) {
			const taskDirPath = getTaskDirectoryPath(id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
			const contextHistoryFilePath = path.join(taskDirPath, GlobalFileNames.contextHistory)
			const taskMetadataFilePath = path.join(taskDirPath, GlobalFileNames.taskMetadata)
			const hasConversationHistory = (
				await Promise.all([
					fileExistsAtPath(apiConversationHistoryFilePath),
					fileExistsAtPath(path.join(taskDirPath, GlobalFileNames.apiConversationHistoryBaseline)),
					fileExistsAtPath(path.join(taskDirPath, GlobalFileNames.apiConversationHistoryOperations)),
				])
			).some(Boolean)
			if (hasConversationHistory) {
				const apiConversationHistory = await getSavedApiConversationHistory(id)
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					contextHistoryFilePath,
					taskMetadataFilePath,
					apiConversationHistory,
				}
			}
		}
		await this.deleteTaskFromState(id)
		throw new Error("Task not found")
	}

	/** Read recent public conversations only; Goal child prompts are agent-authored and private. */
	async getPromptHistory(workspacePath: string, excludedRunId?: string): Promise<UserPrompt[]> {
		const runs = this.stateManager
			.getGlobalStateKey("taskHistory")
			.filter(
				(item) =>
					item.id !== excludedRunId &&
					[item.cwdOnTaskInitialization, item.workspaceRootPath, item.shadowGitConfigWorkTree].some(
						(workspace) => workspace && arePathsEqual(workspace, workspacePath),
					),
			)
			.sort((left, right) => right.ts - left.ts)
			.slice(0, 20)
		const prompts = await Promise.all(
			runs.map(async (run) => {
				try {
					const saved = getUserPrompts(await getSavedDiracMessages(run.id))
					if (saved.length > 0) return saved
				} catch (error) {
					Logger.warn(`[TaskHistoryController] Skipping unreadable transcript for task ${run.id}:`, error)
				}
				return run.task.trim() ? [{ text: run.task, ts: run.ts }] : []
			}),
		)
		return prompts.flat()
	}

	getRunHistoryItem(id: string): RunHistoryItem {
		const item = this.stateManager.getGlobalStateKey("taskHistory").find((candidate) => candidate.id === id)
		if (!item) throw new Error(`Run ${id} is not present in top-level history`)
		return item
	}

	getGoalHistoryItem(id: string): GoalHistoryItem {
		const item = this.getRunHistoryItem(id)
		if (!isGoalHistoryItem(item)) throw new Error(`Run ${id} is not a Goal`)
		return item
	}

	async exportTaskWithId(id: string) {
		const { taskDirPath } = await this.getTaskWithId(id)
		Logger.log(`[EXPORT] Opening task directory: ${taskDirPath}`)
		const open = (await import("open")).default
		await open(taskDirPath)
	}

	async deleteTaskFromState(id: string): Promise<RunHistoryItem[]> {
		return this.stateManager.removeTaskHistoryItems([id])
	}

	async updateRunHistory(item: RunHistoryItem): Promise<RunHistoryItem[]> {
		return this.stateManager.upsertTaskHistoryItem(item)
	}

	async updateTaskHistory(item: HistoryItem): Promise<RunHistoryItem[]> {
		if (!isTaskHistoryItem(item)) throw new Error(`Goal ${item.id} cannot be written through updateTaskHistory`)
		return this.updateRunHistory(item)
	}

	async updateGoalHistory(item: GoalHistoryItem): Promise<RunHistoryItem[]> {
		return this.updateRunHistory(item)
	}

	/** Deletes complete run storage. Goal children remain private and are cascaded from goal.json. */
	async deleteRunStorage(id: string): Promise<void> {
		await deleteRunStorage(this.getRunHistoryItem(id), this.goalStore)
	}

	async deleteRunWithId(id: string): Promise<RunHistoryItem[]> {
		return withTaskHistoryInventoryLock(async () => {
			await this.deleteRunStorage(id)
			const history = await this.deleteTaskFromState(id)
			await this.stateManager.flushPendingState()
			return history
		})
	}
}
