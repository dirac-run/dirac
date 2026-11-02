import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as taskDirectory from "@core/storage/taskDirectory"
import { Logger } from "@/shared/services/Logger"
import { TaskController } from "./TaskController"

describe("TaskController task lifecycle", () => {
	afterEach(() => sinon.restore())

	function createController(): TaskController {
		return new (TaskController as any)({})
	}

	it("observes detached task failures while preserving them for callers", async () => {
		const controller = createController()
		const failure = new Error("task loop failed")
		const log = sinon.stub(Logger, "error")

		;(controller as any).trackTaskRun(Promise.reject(failure))
		await Promise.resolve()

		sinon.assert.calledWith(log, "Task run failed", failure)
		await assert.rejects(
			() => controller.taskRunPromise!,
			(error: unknown) => error === failure,
		)
	})

	it("waits for historical state restoration without waiting for the follow-up loop", async () => {
		const controller = new (TaskController as any)({ clearTaskSettings: sinon.stub().resolves() }) as TaskController
		let signalRestored!: () => void
		let finishRun!: () => void
		const taskRun = new Promise<void>((resolve) => {
			finishRun = resolve
		})
		const task = {
			taskId: "history-task",
			taskState: {},
			get stateView() {
				return this.taskState
			},
			resumeTaskFromHistory: sinon.stub().callsFake((onRestored: () => void) => {
				signalRestored = onRestored
				return taskRun
			}),
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		controller.task = task
		let didReturn = false

		const start = (controller as any).startHistoricalTaskAndWaitForRestore(task).then(() => {
			didReturn = true
		})
		await Promise.resolve()
		assert.equal(didReturn, false)

		signalRestored()
		await start
		assert.equal(didReturn, true)

		finishRun()
		await controller.taskRunPromise
	})

	it("clears a historical task whose restoration fails", async () => {
		const failure = new Error("unreadable transcript")
		sinon.stub(Logger, "error")
		const clearTaskSettings = sinon.stub().resolves()
		const controller = new (TaskController as any)({ clearTaskSettings }) as TaskController
		const task = {
			taskId: "broken-history-task",
			taskState: {},
			get stateView() {
				return this.taskState
			},
			resumeTaskFromHistory: sinon.stub().rejects(failure),
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		controller.task = task

		await assert.rejects(
			() => (controller as any).startHistoricalTaskAndWaitForRestore(task),
			(error: unknown) => error === failure,
		)

		sinon.assert.calledOnce(clearTaskSettings)
		sinon.assert.calledOnce(task.abortTask)
		assert.equal(controller.task, undefined)
	})

	it("surfaces a task failure that occurs before historical restoration", async () => {
		const clearTaskSettings = sinon.stub().resolves()
		const controller = new (TaskController as any)({ clearTaskSettings }) as TaskController
		const stack = "StorageReplayError: Invalid operation record\n    at replayOperationRecords"
		const task = {
			taskId: "invalid-operation-history-task",
			taskState: {},
			get stateView() {
				return this.taskState
			},
			resumeTaskFromHistory: sinon.stub().resolves({
				kind: "failed",
				error: { name: "StorageReplayError", message: "Invalid operation record", stack },
				failedAt: 1,
			}),
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		controller.task = task

		await assert.rejects(
			() => (controller as any).startHistoricalTaskAndWaitForRestore(task),
			(error: Error) =>
				error.name === "StorageReplayError" && error.message === "Invalid operation record" && error.stack === stack,
		)

		sinon.assert.calledOnce(clearTaskSettings)
		sinon.assert.calledOnce(task.abortTask)
		assert.equal(controller.task, undefined)
	})

	it("times out a historical task that never reaches restoration readiness", async () => {
		const clock = sinon.useFakeTimers()
		const clearTaskSettings = sinon.stub().resolves()
		const controller = new (TaskController as any)({ clearTaskSettings }) as TaskController
		const task = {
			taskId: "stalled-history-task",
			taskState: {},
			get stateView() {
				return this.taskState
			},
			resumeTaskFromHistory: sinon.stub().returns(new Promise<void>(() => {})),
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		controller.task = task

		const start = (controller as any).startHistoricalTaskAndWaitForRestore(task)
		await clock.tickAsync(30_000)

		await assert.rejects(start, /history restoration timed out after 30 seconds/)
		sinon.assert.calledOnce(clearTaskSettings)
		sinon.assert.calledOnce(task.abortTask)
		assert.equal(controller.task, undefined)
	})

	it("rejects a historical open that is replaced before restoration completes", async () => {
		const controller = new (TaskController as any)({ clearTaskSettings: sinon.stub().resolves() }) as TaskController
		let signalRestored!: () => void
		let finishRun!: () => void
		const taskRun = new Promise<void>((resolve) => {
			finishRun = resolve
		})
		const task = {
			taskId: "replaced-history-task",
			taskState: {},
			get stateView() {
				return this.taskState
			},
			resumeTaskFromHistory: sinon.stub().callsFake((onRestored: () => void) => {
				signalRestored = onRestored
				return taskRun
			}),
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		controller.task = task
		const start = (controller as any).startHistoricalTaskAndWaitForRestore(task)
		await Promise.resolve()

		controller.task = { taskId: "newer-task" } as any
		signalRestored()

		await assert.rejects(start, /was replaced before its history finished restoring/)
		finishRun()
		await controller.taskRunPromise
	})

	it("retains a failed historical owner until shutdown settles beyond the former cleanup timeout", async () => {
		const clock = sinon.useFakeTimers()
		const failure = new Error("unreadable transcript")
		sinon.stub(Logger, "error")
		let finishAbort!: () => void
		const abort = new Promise<void>((resolve) => {
			finishAbort = resolve
		})
		const controller = new (TaskController as any)({ clearTaskSettings: sinon.stub().resolves() }) as TaskController
		const task = {
			taskId: "slow-cleanup",
			resumeTaskFromHistory: sinon.stub().rejects(failure),
			abortTask: sinon.stub().returns(abort),
			retirePersistence: sinon.stub().resolves(),
		} as any
		controller.task = task
		let settled = false
		const start = (controller as any).startHistoricalTaskAndWaitForRestore(task).finally(() => {
			settled = true
		})
		const rejected = assert.rejects(start, (error: unknown) => error === failure)
		await clock.tickAsync(6_000)
		assert.equal(settled, false)
		assert.equal(controller.task, task)
		sinon.assert.notCalled(task.retirePersistence)
		finishAbort()
		await rejected
		sinon.assert.calledOnce(task.abortTask)
		sinon.assert.calledOnce(task.retirePersistence)
		assert.equal(controller.task, undefined)
	})

	it("retains the historical owner and reports both restoration and cleanup failures", async () => {
		const failure = new Error("unreadable transcript")
		const cleanupFailure = new Error("child persistence failed")
		sinon.stub(Logger, "error")
		const controller = new (TaskController as any)({ clearTaskSettings: sinon.stub().resolves() }) as TaskController
		const task = {
			taskId: "failed-cleanup",
			resumeTaskFromHistory: sinon.stub().rejects(failure),
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().rejects(cleanupFailure),
		} as any
		controller.task = task
		await assert.rejects((controller as any).startHistoricalTaskAndWaitForRestore(task), (error: AggregateError) => {
			assert.deepEqual(error.errors, [failure, cleanupFailure])
			return true
		})
		assert.equal(controller.task, task)
	})
})

describe("TaskController task isolation", () => {
	afterEach(() => sinon.restore())

	it("does not cancel a task installed while an older task is aborting", async () => {
		let releaseAbort!: () => void
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve
		})
		const oldTask = {
			taskId: "old-task",
			taskState: { isApiRequestActive: false },
			get stateView() {
				return this.taskState
			},
			abortTask: sinon.stub().returns(abortGate),
			retirePersistence: sinon.stub().resolves(),
		} as any
		const newTask = {
			taskId: "new-task",
			taskState: { isApiRequestActive: false },
			get stateView() {
				return this.taskState
			},
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		const controller = new (TaskController as any)({
			task: oldTask,
			postStateToWebview: sinon.stub().resolves(),
			getTaskWithId: sinon.stub().rejects(new Error("not found")),
			clearTaskSettings: sinon.stub().resolves(),
		}) as TaskController

		const cancellation = controller.cancelTask()
		await Promise.resolve()
		controller.task = newTask
		releaseAbort()
		await cancellation

		sinon.assert.notCalled(newTask.abortTask)
		assert.equal(newTask.taskState.abandoned, undefined)
		assert.equal(controller.task, newTask)
	})

	it("does not clear a task installed while older task settings are clearing", async () => {
		let releaseSettings!: () => void
		const settingsGate = new Promise<void>((resolve) => {
			releaseSettings = resolve
		})
		const oldTask = {
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		const newTask = {
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
		} as any
		const controller = new (TaskController as any)({
			task: oldTask,
			clearTaskSettings: sinon.stub().returns(settingsGate),
		}) as TaskController

		const clearing = controller.clearTask()
		await Promise.resolve()
		controller.task = newTask
		releaseSettings()
		await clearing

		sinon.assert.calledOnce(oldTask.abortTask)
		sinon.assert.calledOnce(oldTask.retirePersistence)
		sinon.assert.callOrder(oldTask.abortTask, oldTask.retirePersistence)
		sinon.assert.notCalled(newTask.abortTask)
		sinon.assert.notCalled(newTask.retirePersistence)
		assert.equal(controller.task, newTask)
	})

	it("refuses a locked historical task before clearing the current task or loading settings", async () => {
		sinon.stub(taskDirectory, "getTaskDirectoryPath").returns("/storage/tasks/locked-task")
		const failure = new Error("This task is already open in another Dirac instance.")
		const currentTask = { taskId: "current-task", abortTask: sinon.stub(), retirePersistence: sinon.stub() } as any
		const stateManager = { loadTaskSettings: sinon.stub(), refreshModelProviderPresetsFromDisk: sinon.stub() } as any
		const acquire = sinon.stub().rejects(failure)
		const clearTaskSettings = sinon.stub()
		const controller = new (TaskController as any)(
			{ controller: {}, task: currentTask, stateManager, clearTaskSettings },
			acquire,
		) as TaskController

		await assert.rejects(
			() => controller.initTask(undefined, undefined, undefined, { id: "locked-task" } as any),
			(error: unknown) => error === failure,
		)
		sinon.assert.calledOnceWithExactly(acquire, "/storage/tasks/locked-task")
		sinon.assert.notCalled(clearTaskSettings)
		sinon.assert.notCalled(currentTask.abortTask)
		sinon.assert.notCalled(stateManager.loadTaskSettings)
		assert.equal(controller.task, currentTask)
	})

	it("releases an acquired task lock when initialization fails", async () => {
		sinon.stub(taskDirectory, "getTaskDirectoryPath").returns("/storage/tasks/task")
		const releaseTaskLock = sinon.stub().resolves()
		const initializationFailure = new Error("settings failed")
		const stateManager = {
			refreshModelProviderPresetsFromDisk: sinon.stub(),
			getGlobalSettingsKey: sinon.stub().returns(undefined),
			getGlobalStateKey: sinon.stub().returns(undefined),
			loadTaskSettings: sinon.stub().rejects(initializationFailure),
		} as any
		const workspaceManager = {
			getPrimaryRoot: () => ({ path: "/workspace" }),
		}
		const controller = new (TaskController as any)(
			{
				controller: {},
				stateManager,
				clearTaskSettings: sinon.stub().resolves(),
				postStateToWebview: sinon.stub().resolves(),
			},
			sinon.stub().resolves(releaseTaskLock),
			sinon.stub().resolves(workspaceManager),
		) as TaskController

		await assert.rejects(
			() => controller.initTask("test"),
			(error: unknown) => error === initializationFailure,
		)

		sinon.assert.calledOnce(releaseTaskLock)
	})

	it("captures task working configuration after persisted settings and runtime overrides", async () => {
		sinon.stub(taskDirectory, "getTaskDirectoryPath").returns("/storage/tasks/task")
		const order: string[] = []
		const workingConfiguration = {
			revision: 1,
			settings: { shellIntegrationTimeout: 4321, terminalOutputLineLimit: 250, defaultTerminalProfile: "zsh" },
			apiConfiguration: {},
			workspaceConfiguration: {},
			executionOptions: {
				terminalReuseEnabled: false,
				vscodeTerminalExecutionMode: "backgroundExec",
				multiRootEnabled: false,
			},
		}
		const capture = sinon.stub().callsFake((runtimeOverrides: unknown) => {
			order.push("capture")
			assert.deepEqual(runtimeOverrides, { mode: "plan" })
			return workingConfiguration
		})
		const stateManager = {
			refreshModelProviderPresetsFromDisk: sinon.stub(),
			getGlobalStateKey: sinon.stub().returns(undefined),
			loadTaskSettings: sinon.stub().callsFake(async () => order.push("load")),
			setTaskSettingsBatch: sinon.stub().callsFake(() => order.push("persisted")),
			captureEffectiveTaskConfiguration: capture,
		} as any
		const workspaceManager = { getPrimaryRoot: () => ({ path: "/workspace" }) }
		const controller = new (TaskController as any)(
			{
				controller: {},
				stateManager,
				clearTaskSettings: sinon.stub().resolves(),
				postStateToWebview: sinon.stub().resolves(),
			},
			sinon.stub().resolves(sinon.stub().resolves()),
			sinon.stub().resolves(workspaceManager),
		) as TaskController

		await assert.rejects(
			() =>
				controller.initTask("test", undefined, undefined, undefined, { mode: "act" }, undefined, undefined, {
					runtimeConfigurationOverrides: { mode: "plan" },
				}),
			/HostProvider|Either historyItem|undefined/,
		)
		assert.deepEqual(order.slice(0, 3), ["load", "persisted", "capture"])
	})
	it("reconstructs from the latest committed task configuration instead of constructor-time overrides", async () => {
		const originalOwnerOptions = {
			runtimeConfigurationOverrides: { mode: "act", autoApproveAllToggled: false },
		} as const
		const latestWorkingConfiguration = {
			revision: 7,
			settings: { mode: "plan", autoApproveAllToggled: true },
		} as any
		const historyItem = { id: "persisted-task" } as any
		const task = { getWorkingConfiguration: () => latestWorkingConfiguration } as any
		const controller = new (TaskController as any)({
			task,
			getTaskWithId: sinon.stub().resolves({ historyItem }),
		}) as TaskController
		;(controller as any).currentInitializationOptions = originalOwnerOptions
		const initTask = sinon.stub(controller, "initTask").resolves(historyItem.id)

		await controller.reinitExistingTaskFromId(historyItem.id)

		sinon.assert.calledOnce(initTask)
		assert.equal(initTask.firstCall.args[3], historyItem)
		const reconstructionOptions = initTask.firstCall.args[7]!
		assert.equal(reconstructionOptions.workingConfiguration, latestWorkingConfiguration)
		assert.equal(reconstructionOptions.runtimeConfigurationOverrides, undefined)
	})

	it("forwards the owning runtime through cancellation recreation after defaults change", async () => {
		const ownerOptions = {
			runtimeConfigurationOverrides: { mode: "plan", autoApproveAllToggled: true, yoloModeToggled: false },
		} as const
		const historyItem = { id: "cancelled-task" } as any
		const latestWorkingConfiguration = {
			revision: 5,
			settings: { mode: "act", autoApproveAllToggled: false, yoloModeToggled: false },
		} as any
		const task = {
			taskId: historyItem.id,
			taskState: { isApiRequestActive: false },
			get stateView() {
				return this.taskState
			},
			abortTask: sinon.stub().resolves(),
			retirePersistence: sinon.stub().resolves(),
			getWorkingConfiguration: () => latestWorkingConfiguration,
		} as any
		const postStateToWebview = sinon.stub().resolves()
		const controller = new (TaskController as any)({
			task,
			getTaskWithId: sinon.stub().resolves({ historyItem }),
			postStateToWebview,
		}) as TaskController
		;(controller as any).currentInitializationOptions = ownerOptions
		;(controller as any).currentConversationUlid = "conversation"
		const initTask = sinon.stub(controller, "initTask").callsFake(async (...args: any[]) => {
			assert.equal(args[7].workingConfiguration, latestWorkingConfiguration)
			assert.equal(args[7].runtimeConfigurationOverrides, undefined)
			return historyItem.id
		})

		await controller.cancelTask()

		sinon.assert.calledOnce(initTask)
		assert.equal(initTask.firstCall.args[3], historyItem)
		assert.equal(initTask.firstCall.args[5], "conversation")
		sinon.assert.calledOnce(postStateToWebview)
	})

	it("attempts abort and persistence retirement even when settings cleanup fails", async () => {
		const failure = new Error("settings failed")
		const task = { abortTask: sinon.stub().resolves(), retirePersistence: sinon.stub().resolves() } as any
		const controller = new (TaskController as any)({
			task,
			clearTaskSettings: sinon.stub().rejects(failure),
		}) as TaskController
		await assert.rejects(controller.clearTask(), (error: unknown) => error === failure)
		sinon.assert.callOrder(task.abortTask, task.retirePersistence)
		sinon.assert.calledOnce(task.abortTask)
		sinon.assert.calledOnce(task.retirePersistence)
		assert.equal(controller.task, task)
	})

	it("reports every cleanup failure after attempting persistence retirement", async () => {
		const failures = [new Error("settings failed"), new Error("abort failed"), new Error("persistence failed")]
		const task = {
			abortTask: sinon.stub().rejects(failures[1]),
			retirePersistence: sinon.stub().rejects(failures[2]),
		} as any
		const controller = new (TaskController as any)({
			task,
			clearTaskSettings: sinon.stub().rejects(failures[0]),
		}) as TaskController
		await assert.rejects(controller.clearTask(), (error: AggregateError) => {
			assert.deepEqual(error.errors, failures)
			return true
		})
		sinon.assert.callOrder(task.abortTask, task.retirePersistence)
		assert.equal(controller.task, task)
	})
})
describe("TaskController follow-up readiness", () => {
	afterEach(() => sinon.restore())

	function taskAt(status: string, runOutcome?: object) {
		return {
			taskId: "persisted-task",
			stateView: { status, runOutcome, didAttemptCompletion: false },
		} as any
	}

	it("keeps live completed and restored cancelled tasks waiting on the same conversation", async () => {
		const controller = new (TaskController as any)({}) as TaskController
		const restore = sinon.stub(controller, "reinitExistingTaskFromId")
		for (const status of ["completed", "cancelled", "awaiting_user_input"]) {
			const task = taskAt(status)
			controller.task = task
			assert.equal(await controller.prepareTaskForFollowUp(), task)
		}
		sinon.assert.notCalled(restore)
	})

	it("waits for completion publication before accepting a live follow-up", async () => {
		const clock = sinon.useFakeTimers()
		const controller = new (TaskController as any)({}) as TaskController
		const task = taskAt("executing_tool")
		task.stateView.didAttemptCompletion = true
		controller.task = task
		let ready = false
		const preparation = controller.prepareTaskForFollowUp().then(() => {
			ready = true
		})
		await clock.tickAsync(10)
		assert.equal(ready, false)
		task.stateView.status = "completed"
		await clock.tickAsync(10)
		await preparation
		assert.equal(ready, true)
	})

	it("restores ended runs using the same task ID and owning runtime", async () => {
		const controller = new (TaskController as any)({}) as TaskController
		const runtime = { runtimeConfigurationOverrides: { mode: "plan" } } as const
		const restored = taskAt("cancelled")
		const restore = sinon.stub(controller, "reinitExistingTaskFromId").callsFake(async () => {
			controller.task = restored
		})
		for (const kind of ["completed", "failed", "cancelled", "interrupted"]) {
			controller.task = taskAt("completed", { kind })
			assert.equal(await controller.prepareTaskForFollowUp(runtime), restored)
			sinon.assert.calledWithExactly(restore, "persisted-task", runtime)
		}
		assert.equal(restore.callCount, 4)
	})

	it("surfaces restoration failures instead of starting a fresh task", async () => {
		const controller = new (TaskController as any)({}) as TaskController
		controller.task = taskAt("idle", { kind: "failed" })
		const initTask = sinon.stub(controller, "initTask")
		sinon.stub(controller, "reinitExistingTaskFromId").rejects(new Error("history unreadable"))
		await assert.rejects(controller.prepareTaskForFollowUp(), /history unreadable/)
		sinon.assert.notCalled(initTask)
	})
})
