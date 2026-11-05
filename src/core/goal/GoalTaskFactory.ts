import type { Controller } from "@core/controller"
import type { StateManager } from "@core/storage/StateManager"
import { Task, type TaskParams } from "@core/task"
import type { TaskWorkingConfiguration } from "@core/task/runtime/TaskWorkingConfiguration"
import type { ToolEnvironmentFactory } from "@core/task/tools/interfaces/ToolEnvironmentFactory"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { HistoryItem } from "@shared/HistoryItem"

export interface GoalTaskConstruction {
	id: string
	conversationUlid: string
	prompt?: string
	historyItem?: HistoryItem
	environmentFactory: ToolEnvironmentFactory
	getPinnedContext?: () => Promise<string | undefined>
	onHistorySnapshot: (item: HistoryItem, task: Task) => Promise<void>
	duringTaskletUserInteraction?: TaskParams["duringTaskletUserInteraction"]
	conversationPersistenceHooks?: TaskParams["conversationPersistenceHooks"]
	executionProfile: "goal_coordinator" | "goal_followup"
}

export interface GoalTaskFactoryDependencies {
	controller: Controller
	stateManager: StateManager
	workspaceManager: WorkspaceRootManager
	cwd: string
	workingConfiguration: TaskWorkingConfiguration
	postCoordinatorState: () => Promise<void>
}

/** Constructs Goal roots; their ordinary TaskletHost owns all private children. */
export class GoalTaskFactory {
	constructor(private readonly dependencies: GoalTaskFactoryDependencies) {}

	async create(input: GoalTaskConstruction): Promise<Task> {
		// GoalLoop holds the root lock until the Task and its owned tasklets retire.
		const workingConfiguration = this.dependencies.workingConfiguration
		let task!: Task
		const params: TaskParams = {
			controller: this.dependencies.controller,
			updateTaskHistory: async (item) => {
				await input.onHistorySnapshot(item, task)
				return this.dependencies.stateManager.getGlobalStateKey("taskHistory")
			},
			postStateToWebview: this.dependencies.postCoordinatorState,
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
			getPinnedContext: input.getPinnedContext,
			executionProfile: input.executionProfile,
			toolEnvironmentFactory: input.environmentFactory,
			duringTaskletUserInteraction: input.duringTaskletUserInteraction,
			conversationPersistenceHooks: input.conversationPersistenceHooks,
			updateBackgroundCommandState: (running, taskId) =>
				this.dependencies.controller.updateBackgroundCommandState(running, taskId),
		}
		task = new Task(params)
		return task
	}
}
