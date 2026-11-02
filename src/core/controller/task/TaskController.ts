import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import type { HistoryItem } from "@shared/HistoryItem"
import { TaskStatus } from "@shared/ExtensionMessage"
import { type Settings } from "@shared/storage/state-keys"
import pTimeout from "p-timeout"
import pWaitFor from "p-wait-for"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import type { StateManager } from "../../storage/StateManager"
import { getTaskDirectoryPath } from "../../storage/taskDirectory"
import { Task } from "../../task"
import {
	createTaskWorkingConfiguration,
	type TaskWorkingConfiguration,
	type TaskWorkingConfigurationInput,
} from "../../task/runtime/TaskWorkingConfiguration"
import { acquireTaskLock } from "../../task/TaskLockUtils"
import { deserializeTaskError } from "../../task/TaskRunOutcome"
import { detectWorkspaceRoots } from "../../workspace/detection"
import { setupWorkspaceManager } from "../../workspace/setup"
import type { WorkspaceRootManager } from "../../workspace/WorkspaceRootManager"
import type { Controller } from ".."

export type TaskInitializationOptions = {
	pinnedContext?: string
	onContextCompacted?: () => void
	switchToActMode?: () => Promise<boolean>
	enqueueSteeringMessages?: (task: Task) => Promise<void>
	toolSelectionPolicy?: import("../../task/tools/runtime/ToolSelectionPolicy").ToolSelectionPolicy
	/** Host/session-owned runtime values; capture input only and never task-settings persistence. */
	runtimeConfigurationOverrides?: Partial<Settings>
	/** Exact immutable runtime used only when reconstructing an existing active Task. */
	workingConfiguration?: TaskWorkingConfiguration
}

export interface ITaskControllerDependencies {
	task?: Task
	controller: Controller | undefined
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	workspaceCwd?: string
	backgroundCommandRunning: boolean
	backgroundCommandTaskId?: string
	cancelInProgress: boolean
	postStateToWebview: () => Promise<void>
	postPresentationToWebview?: () => Promise<void>
	updateTaskHistory: (item: HistoryItem) => Promise<HistoryItem[]>
	deleteTaskFromState: (id: string) => Promise<any>
	getTaskWithId: (id: string) => Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: any[]
	}>
	clearTaskSettings: () => Promise<void>
	toggleActModeForYoloMode: () => Promise<boolean>
}

const HISTORICAL_TASK_RESTORE_TIMEOUT_MS = 30_000
export class TaskController {
	private _task?: Task
	private _workspaceManager?: WorkspaceRootManager
	private _backgroundCommandRunning = false
	private _backgroundCommandTaskId?: string
	private cancelInProgress = false
	private _taskRunPromise?: Promise<void>
	private currentConversationUlid?: string
	private currentInitializationOptions?: TaskInitializationOptions

	// Promise for the in-flight task run; consumed via Controller.taskRunPromise (from main).
	get taskRunPromise(): Promise<void> | undefined {
		return this._taskRunPromise
	}

	constructor(
		private readonly deps: ITaskControllerDependencies,
		private readonly acquireTaskLockFn: typeof acquireTaskLock = acquireTaskLock,
		private readonly setupWorkspaceManagerFn: typeof setupWorkspaceManager = setupWorkspaceManager,
		private readonly detectRootsFn: typeof detectWorkspaceRoots = detectWorkspaceRoots,
		private readonly getCwdFn: (defaultDir: string) => Promise<string> = getCwd,
		private readonly getDesktopDirFn: () => string = getDesktopDir,
		private readonly cleanupLegacyCheckpointsFn: () => Promise<void> = cleanupLegacyCheckpoints,
		private readonly cancelBackgroundCommandFn: () => Promise<boolean>,
	) {
		this._task = deps.task
		this._workspaceManager = deps.workspaceManager
	}

	get task(): Task | undefined {
		return this._task
	}

	set task(value: Task | undefined) {
		this._task = value
	}

	get workspaceManager(): WorkspaceRootManager | undefined {
		return this._workspaceManager
	}

	set workspaceManager(value: WorkspaceRootManager | undefined) {
		this._workspaceManager = value
	}

	get backgroundCommandRunning() {
		return this._backgroundCommandRunning
	}

	get backgroundCommandTaskId() {
		return this._backgroundCommandTaskId
	}

	/** Return a live task ready for follow-up input, restoring ended runs without losing their conversation. */
	async prepareTaskForFollowUp(initializationOptions?: TaskInitializationOptions): Promise<Task> {
		const task = this._task
		if (!task) throw new Error("No task available for follow-up")

		// Completion output can reach the client before the loop clears its previous response.
		if (task.stateView.didAttemptCompletion && !task.stateView.runOutcome) {
			await pWaitFor(
				() =>
					this._task !== task ||
					task.stateView.runOutcome !== undefined ||
					task.stateView.status === TaskStatus.COMPLETED ||
					task.stateView.status === TaskStatus.AWAITING_USER_INPUT,
				{ interval: 10 },
			)
		}
		if (this._task !== task) throw new Error(`Task ${task.taskId} changed while preparing a follow-up`)

		const waitingForInput =
			task.stateView.status === TaskStatus.COMPLETED ||
			task.stateView.status === TaskStatus.CANCELLED ||
			task.stateView.status === TaskStatus.AWAITING_USER_INPUT
		if (!task.stateView.runOutcome && waitingForInput) return task

		await this.reinitExistingTaskFromId(task.taskId, initializationOptions)
		if (!this._task) throw new Error(`Task ${task.taskId} was not restored for follow-up`)
		return this._task
	}

	private reconstructionInitializationOptions(task: Task): TaskInitializationOptions {
		const {
			runtimeConfigurationOverrides: _runtimeOverrides,
			workingConfiguration: _workingConfiguration,
			...callbacks
		} = this.currentInitializationOptions ?? {}
		return {
			...callbacks,
			workingConfiguration: task.getWorkingConfiguration(),
		}
	}

	private trackTaskRun(run: Promise<void>): void {
		this._taskRunPromise = run
		void run.catch((error) => Logger.error("Task run failed", error))
	}

	private async startHistoricalTaskAndWaitForRestore(task: Task): Promise<void> {
		let didRestore = false
		let resolveRestore!: () => void
		let rejectRestore!: (reason?: unknown) => void
		const restored = new Promise<void>((resolve, reject) => {
			resolveRestore = resolve
			rejectRestore = reject
		})

		const taskRun = task.resumeTaskFromHistory(() => {
			didRestore = true
			resolveRestore()
		})
		this.trackTaskRun(taskRun.then(() => undefined))
		void taskRun.then(
			(outcome) => {
				if (didRestore) return
				if (outcome.kind === "failed") {
					rejectRestore(deserializeTaskError(outcome.error))
					return
				}
				rejectRestore(new Error(`Task ${task.taskId} ended before its history was restored`))
			},
			(error) => rejectRestore(error),
		)

		try {
			await pTimeout(restored, {
				milliseconds: HISTORICAL_TASK_RESTORE_TIMEOUT_MS,
				message: `Task ${task.taskId} history restoration timed out after ${HISTORICAL_TASK_RESTORE_TIMEOUT_MS / 1_000} seconds`,
			})
			if (this._task !== task) {
				throw new Error(`Task ${task.taskId} was replaced before its history finished restoring`)
			}
		} catch (error) {
			if (this._task === task) {
				try {
					await this.clearTask()
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], `Task ${task.taskId} history restoration and cleanup failed`)
				}
			}
			throw error
		}
	}

	async initTask(
		task?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		conversationUlid?: string,
		_watcherFactory?: any,
		initializationOptions?: TaskInitializationOptions,
	): Promise<string> {
		if (!this.deps.controller) {
			throw new Error("TaskController.initTask requires a Controller instance")
		}
		const controller = this.deps.controller
		const taskId = historyItem?.id || Date.now().toString()
		// Same-ID reconstruction must retire our current writer before reacquiring ownership.
		if (this._task?.taskId === taskId) await this.clearTask()
		const releaseTaskLock = await this.acquireTaskLockFn(getTaskDirectoryPath(taskId))

		try {
			await this.clearTask()
			this.currentConversationUlid = conversationUlid
			this.currentInitializationOptions = initializationOptions
			this.deps.stateManager.refreshModelProviderPresetsFromDisk()

			const isNewUser = this.deps.stateManager.getGlobalStateKey("isNewUser")
			const taskHistory = this.deps.stateManager.getGlobalStateKey("taskHistory")
			const NEW_USER_TASK_COUNT_THRESHOLD = 10
			if (isNewUser && !historyItem && taskHistory && taskHistory.length >= NEW_USER_TASK_COUNT_THRESHOLD) {
				this.deps.stateManager.setGlobalState("isNewUser", false)
				await this.deps.postStateToWebview()
			}

			this._workspaceManager = this.deps.workspaceCwd
				? await controller.ensureWorkspaceManager()
				: await this.setupWorkspaceManagerFn({
						stateManager: this.deps.stateManager,
						detectRoots: this.detectRootsFn,
					})
			if (!this._workspaceManager) {
				throw new Error("TaskController.initTask could not initialize a workspace manager")
			}
			const cwd = this._workspaceManager.getPrimaryRoot()?.path || (await this.getCwdFn(this.getDesktopDirFn()))
			await this.deps.stateManager.loadTaskSettings(taskId)
			if (taskSettings) {
				this.deps.stateManager.setTaskSettingsBatch(taskId, taskSettings)
			}

			const suppliedWorkingConfiguration = initializationOptions?.workingConfiguration
			const workingConfiguration: TaskWorkingConfiguration = suppliedWorkingConfiguration
				? createTaskWorkingConfiguration({
						revision: suppliedWorkingConfiguration.revision,
						settings: suppliedWorkingConfiguration.settings as Settings,
						apiConfiguration: structuredClone(
							suppliedWorkingConfiguration.apiConfiguration,
						) as TaskWorkingConfigurationInput["apiConfiguration"],
						workspaceConfiguration: structuredClone(
							suppliedWorkingConfiguration.workspaceConfiguration,
						) as TaskWorkingConfigurationInput["workspaceConfiguration"],
						executionOptions: structuredClone(
							suppliedWorkingConfiguration.executionOptions,
						) as TaskWorkingConfigurationInput["executionOptions"],
					})
				: this.deps.stateManager.captureEffectiveTaskConfiguration(initializationOptions?.runtimeConfigurationOverrides)
			const { settings, executionOptions } = workingConfiguration

			this._task = new Task({
				controller,
				updateTaskHistory: (historyItem) => this.deps.updateTaskHistory(historyItem),
				postStateToWebview: () => this.deps.postStateToWebview(),
				postPresentationToWebview: () => (this.deps.postPresentationToWebview ?? this.deps.postStateToWebview)(),
				reinitExistingTaskFromId: (taskId) => this.reinitExistingTaskFromId(taskId),
				cancelTask: () => this.cancelTask(),
				shellIntegrationTimeout: settings.shellIntegrationTimeout,
				terminalReuseEnabled: executionOptions.terminalReuseEnabled,
				terminalOutputLineLimit: settings.terminalOutputLineLimit,
				defaultTerminalProfile: settings.defaultTerminalProfile,
				vscodeTerminalExecutionMode: executionOptions.vscodeTerminalExecutionMode,
				cwd,
				stateManager: this.deps.stateManager,
				workingConfiguration,
				workspaceManager: this._workspaceManager,
				task,
				images,
				files,
				historyItem,
				taskId,
				conversationUlid,
				releaseTaskLock,
				pinnedContext: initializationOptions?.pinnedContext,
				onContextCompacted: initializationOptions?.onContextCompacted,
				switchToActMode: initializationOptions?.switchToActMode,
				toolSelectionPolicy: initializationOptions?.toolSelectionPolicy,
				enqueuePreRequestSteeringMessages: async () => initializationOptions?.enqueueSteeringMessages?.(this._task!),
			})
		} catch (error) {
			await releaseTaskLock()
			throw error
		}

		this.currentConversationUlid = this._task.ulid
		if (historyItem) {
			await this.startHistoricalTaskAndWaitForRestore(this._task)
		} else if (task || images || files) {
			this.trackTaskRun(this._task.startTask(task, images, files).then(() => undefined))
		} else {
			this._taskRunPromise = undefined
		}
		return this._task.taskId
	}

	async reinitExistingTaskFromId(taskId: string, initializationOptions?: TaskInitializationOptions) {
		const effectiveInitializationOptions =
			initializationOptions ??
			(this._task ? this.reconstructionInitializationOptions(this._task) : this.currentInitializationOptions)
		const history = await this.deps.getTaskWithId(taskId)
		if (history) {
			await this.initTask(
				undefined,
				undefined,
				undefined,
				history.historyItem,
				undefined,
				this.currentConversationUlid,
				undefined,
				effectiveInitializationOptions,
			)
		}
	}

	async cancelTask() {
		if (this.cancelInProgress) {
			Logger.log(`[Controller.cancelTask] Cancellation already in progress, ignoring duplicate request`)
			return
		}

		if (!this._task) {
			return
		}
		const task = this._task

		this.cancelInProgress = true

		try {
			this.updateBackgroundCommandState(false)

			try {
				await task.abortTask()
			} catch (error) {
				Logger.error("Failed to abort task", error)
			}
			if (this._task !== task) return

			await pWaitFor(
				() =>
					task.stateView.isApiRequestActive === false ||
					task.stateView.didFinishAbortingStream ||
					task.stateView.isWaitingForFirstChunk,
				{
					timeout: 3_000,
				},
			).catch(() => {
				Logger.error("Failed to abort task")
			})
			if (this._task !== task) return

			task.taskState.abandoned = true

			let historyItem: HistoryItem | undefined
			try {
				const result = await this.deps.getTaskWithId(task.taskId)
				historyItem = result.historyItem
			} catch (error) {
				Logger.log(`[Controller.cancelTask] Task not found in history: ${error}`)
			}
			if (this._task !== task) return

			if (historyItem) {
				await this.initTask(
					undefined,
					undefined,
					undefined,
					historyItem,
					undefined,
					this.currentConversationUlid,
					undefined,
					this.reconstructionInitializationOptions(task),
				)
			} else {
				await this.clearTask()
			}

			await this.deps.postStateToWebview()
		} finally {
			this.cancelInProgress = false
		}
	}

	updateBackgroundCommandState(running: boolean, taskId?: string) {
		const nextTaskId = running ? taskId : undefined
		if (this._backgroundCommandRunning === running && this._backgroundCommandTaskId === nextTaskId) {
			return
		}
		this._backgroundCommandRunning = running
		this._backgroundCommandTaskId = nextTaskId
		void this.deps.postStateToWebview()
	}

	async cancelBackgroundCommand(): Promise<void> {
		// Prefer the live task's executor; the injected fn is an init-time no-op placeholder.
		const didCancel = (await this._task?.cancelBackgroundCommand()) ?? (await this.cancelBackgroundCommandFn())
		if (!didCancel) {
			this.updateBackgroundCommandState(false)
		}
	}

	async clearTask() {
		const task = this._task
		if (task) {
			const failures: unknown[] = []
			try {
				await this.deps.clearTaskSettings()
			} catch (error) {
				failures.push(error)
			}
			try {
				await task.abortTask()
			} catch (error) {
				failures.push(error)
			}
			try {
				await task.retirePersistence()
			} catch (error) {
				failures.push(error)
			}
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, "Task cleanup failed")
		}
		if (this._task === task) {
			this._task = undefined
		}
	}
}
