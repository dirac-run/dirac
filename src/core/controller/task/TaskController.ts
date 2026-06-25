import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import type { HistoryItem } from "@shared/HistoryItem"
import { type Settings } from "@shared/storage/state-keys"
import pWaitFor from "p-wait-for"
import type { FolderLockWithRetryResult } from "@/core/locks/types"
import { Logger } from "@/shared/services/Logger"
import { getCwd, getDesktopDir } from "@/utils/path"
import type { StateManager } from "../../storage/StateManager"
import { Task } from "../../task"
import { tryAcquireTaskLockWithRetry } from "../../task/TaskLockUtils"
import { detectWorkspaceRoots } from "../../workspace/detection"
import { setupWorkspaceManager } from "../../workspace/setup"
import type { WorkspaceRootManager } from "../../workspace/WorkspaceRootManager"
import type { Controller } from ".."

export interface ITaskControllerDependencies {
	task?: Task
	controller: Controller | undefined
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	backgroundCommandRunning: boolean
	backgroundCommandTaskId?: string
	cancelInProgress: boolean
	postStateToWebview: () => Promise<void>
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

export class TaskController {
	private _task?: Task
	private _workspaceManager?: WorkspaceRootManager
	private _backgroundCommandRunning = false
	private _backgroundCommandTaskId?: string
	private cancelInProgress = false
	private _taskRunPromise?: Promise<void>

	// Promise for the in-flight task run; consumed via Controller.taskRunPromise (from main).
	get taskRunPromise(): Promise<void> | undefined {
		return this._taskRunPromise
	}

	constructor(
		private readonly deps: ITaskControllerDependencies,
		private readonly tryAcquireTaskLockWithRetryFn: typeof tryAcquireTaskLockWithRetry = tryAcquireTaskLockWithRetry,
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

	async initTask(
		task?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		conversationUlid?: string,
		_watcherFactory?: any,
	): Promise<string> {
		// Controller is required to construct a Task; fail fast with a clear error if missing
		if (!this.deps.controller) {
			throw new Error("TaskController.initTask requires a Controller instance")
		}
		const controller = this.deps.controller
		await this.clearTask()

		const autoApprovalSettings = this.deps.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const shellIntegrationTimeout = this.deps.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.deps.stateManager.getGlobalStateKey("terminalReuseEnabled")
		const vscodeTerminalExecutionMode = this.deps.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
		const terminalOutputLineLimit = this.deps.stateManager.getGlobalSettingsKey("terminalOutputLineLimit")
		const defaultTerminalProfile = this.deps.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		const isNewUser = this.deps.stateManager.getGlobalStateKey("isNewUser")
		const taskHistory = this.deps.stateManager.getGlobalStateKey("taskHistory")

		const NEW_USER_TASK_COUNT_THRESHOLD = 10

		if (isNewUser && !historyItem && taskHistory && taskHistory.length >= NEW_USER_TASK_COUNT_THRESHOLD) {
			this.deps.stateManager.setGlobalState("isNewUser", false)
			await this.deps.postStateToWebview()
		}

		this._workspaceManager = await this.setupWorkspaceManagerFn({
			stateManager: this.deps.stateManager,
			detectRoots: this.detectRootsFn,
		})

		const cwd = this._workspaceManager?.getPrimaryRoot()?.path || (await this.getCwdFn(this.getDesktopDirFn()))

		const taskId = historyItem?.id || Date.now().toString()

		let taskLockAcquired = false
		const lockResult: FolderLockWithRetryResult = await this.tryAcquireTaskLockWithRetryFn(taskId)

		if (!lockResult.acquired && !lockResult.skipped) {
			const errorMessage = lockResult.conflictingLock
				? `Task locked by instance (${lockResult.conflictingLock.held_by})`
				: "Failed to acquire task lock"
			throw new Error(errorMessage)
		}

		taskLockAcquired = lockResult.acquired
		if (lockResult.acquired) {
			Logger.debug(`[Task ${taskId}] Task lock acquired`)
		} else {
			Logger.debug(`[Task ${taskId}] Task lock skipped (VS Code)`)
		}

		await this.deps.stateManager.loadTaskSettings(taskId)
		if (taskSettings) {
			this.deps.stateManager.setTaskSettingsBatch(taskId, taskSettings)
		}

		this._task = new Task({
			controller,
			updateTaskHistory: (historyItem) => this.deps.updateTaskHistory(historyItem),
			postStateToWebview: () => this.deps.postStateToWebview(),
			reinitExistingTaskFromId: (taskId) => this.reinitExistingTaskFromId(taskId),
			cancelTask: () => this.cancelTask(),
			shellIntegrationTimeout,
			terminalReuseEnabled: terminalReuseEnabled ?? true,
			terminalOutputLineLimit: terminalOutputLineLimit ?? 500,
			defaultTerminalProfile: defaultTerminalProfile ?? "default",
			vscodeTerminalExecutionMode,
			cwd,
			stateManager: this.deps.stateManager,
			workspaceManager: this._workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			conversationUlid,
			taskLockAcquired,
		})

		if (historyItem) {
			this._taskRunPromise = this._task.resumeTaskFromHistory()
		} else if (task || images || files) {
			this._taskRunPromise = this._task.startTask(task, images, files)
		}

		return this._task.taskId
	}

	async reinitExistingTaskFromId(taskId: string) {
		const history = await this.deps.getTaskWithId(taskId)
		if (history) {
			await this.initTask(undefined, undefined, undefined, history.historyItem)
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

		this.cancelInProgress = true

		try {
			this.updateBackgroundCommandState(false)

			try {
				await this._task.abortTask()
			} catch (error) {
				Logger.error("Failed to abort task", error)
			}

			await pWaitFor(
				() =>
					this._task === undefined ||
					this._task.taskState.isApiRequestActive === false ||
					this._task.taskState.didFinishAbortingStream ||
					this._task.taskState.isWaitingForFirstChunk,
				{
					timeout: 3_000,
				},
			).catch(() => {
				Logger.error("Failed to abort task")
			})

			if (this._task) {
				this._task.taskState.abandoned = true
			}

			let historyItem: HistoryItem | undefined
			try {
				const result = await this.deps.getTaskWithId(this._task!.taskId)
				historyItem = result.historyItem
			} catch (error) {
				Logger.log(`[Controller.cancelTask] Task not found in history: ${error}`)
			}

			if (historyItem) {
				await this.initTask(undefined, undefined, undefined, historyItem, undefined)
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
		const didCancel = await this.cancelBackgroundCommandFn()
		if (!didCancel) {
			this.updateBackgroundCommandState(false)
		}
	}

	async clearTask() {
		if (this._task) {
			await this.deps.clearTaskSettings()
		}
		await this._task?.abortTask()
		this._task = undefined
	}
}
