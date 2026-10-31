import type { Controller } from "@core/controller"
import type { StateManager } from "@core/storage/StateManager"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import { Task, type TaskParams } from "@core/task"
import {
	createTaskWorkingConfiguration,
	type TaskWorkingConfiguration,
	type TaskWorkingConfigurationInput,
} from "@core/task/runtime/TaskWorkingConfiguration"
import type { TaskExecutionProfile } from "@core/task/TaskExecutionProfile"
import { acquireTaskLock } from "@core/task/TaskLockUtils"
import type { ToolEnvironmentFactory } from "@core/task/tools/interfaces/ToolEnvironmentFactory"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { HistoryItem } from "@shared/HistoryItem"
import type { Settings } from "@shared/storage/state-keys"

interface GoalTaskBaseConstruction {
	id: string
	conversationUlid: string
	prompt?: string
	historyItem?: HistoryItem
	environmentFactory: ToolEnvironmentFactory
	getPinnedContext?: () => Promise<string | undefined>
	onHistorySnapshot: (item: HistoryItem, task: Task) => Promise<void>
	conversationPersistenceHooks?: TaskParams["conversationPersistenceHooks"]
}

export type GoalTaskConstruction = GoalTaskBaseConstruction & {
	executionProfile: Extract<TaskExecutionProfile, `goal_${string}`>
}

export interface GoalTaskFactoryDependencies {
	controller: Controller
	stateManager: StateManager
	workspaceManager: WorkspaceRootManager
	cwd: string
	workingConfiguration: TaskWorkingConfiguration
	postCoordinatorState: () => Promise<void>
}

/** Constructs Goal-owned Tasks without routing them through the top-level TaskController. */
export class GoalTaskFactory {
	constructor(private readonly dependencies: GoalTaskFactoryDependencies) { }

	async create(input: GoalTaskConstruction): Promise<Task> {
		// GoalLoop owns the coordinator directory until all owned activity and persistence settle.
		const releaseTaskLock =
			input.executionProfile === "goal_child" ? await acquireTaskLock(getTaskDirectoryPath(input.id)) : undefined

		let task!: Task
		try {
			const workingConfiguration = this.workingConfiguration(input.executionProfile)
			const params: TaskParams = {
				controller: this.dependencies.controller,
				updateTaskHistory: async (item) => {
					await input.onHistorySnapshot(item, task)
					return this.dependencies.stateManager.getGlobalStateKey("taskHistory")
				},
				postStateToWebview:
					input.executionProfile === "goal_coordinator" || input.executionProfile === "goal_followup"
						? this.dependencies.postCoordinatorState
						: async () => undefined,
				reinitExistingTaskFromId: async () => {
					throw new Error("Goal-owned Tasks are reconstructed only by GoalLoop")
				},
				cancelTask: async () => {
					await task.abortTask()
				},
				shellIntegrationTimeout: workingConfiguration.settings.shellIntegrationTimeout,
				terminalReuseEnabled: workingConfiguration.executionOptions.terminalReuseEnabled,
				terminalOutputLineLimit: workingConfiguration.settings.terminalOutputLineLimit,
				defaultTerminalProfile: workingConfiguration.settings.defaultTerminalProfile,
				vscodeTerminalExecutionMode: workingConfiguration.executionOptions.vscodeTerminalExecutionMode,
				cwd: this.dependencies.cwd,
				stateManager: this.dependencies.stateManager,
				workingConfiguration,
				workspaceManager: this.dependencies.workspaceManager,
				task: input.prompt,
				historyItem: input.historyItem,
				taskId: input.id,
				conversationUlid: input.conversationUlid,
				releaseTaskLock,
				getPinnedContext: input.getPinnedContext,
				executionProfile: input.executionProfile,
				toolEnvironmentFactory: input.environmentFactory,
				conversationPersistenceHooks: input.conversationPersistenceHooks,
				updateBackgroundCommandState:
					input.executionProfile === "goal_coordinator" || input.executionProfile === "goal_followup"
						? (running, taskId) => this.dependencies.controller.updateBackgroundCommandState(running, taskId)
						: () => undefined,
			}
			task = new Task(params)
			return task
		} catch (error) {
			await releaseTaskLock?.()
			throw error
		}
	}

	private workingConfiguration(executionProfile: GoalTaskConstruction["executionProfile"]): TaskWorkingConfiguration {
		const source = this.dependencies.workingConfiguration
		if (executionProfile !== "goal_child") return source
		if (!source.settings.hooksEnabled) return source
		return createTaskWorkingConfiguration({
			revision: source.revision,
			settings: {
				...(structuredClone(source.settings) as Settings),
				hooksEnabled: false,
			},
			apiConfiguration: structuredClone(source.apiConfiguration) as TaskWorkingConfigurationInput["apiConfiguration"],
			workspaceConfiguration: structuredClone(
				source.workspaceConfiguration,
			) as TaskWorkingConfigurationInput["workspaceConfiguration"],
			executionOptions: structuredClone(source.executionOptions) as TaskWorkingConfigurationInput["executionOptions"],
		})
	}
}
