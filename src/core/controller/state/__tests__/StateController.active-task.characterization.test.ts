import "should"
import * as apiModule from "@core/api"
import type { TaskWorkingConfigurationPatch } from "@core/task/runtime/TaskWorkingConfiguration"
import { TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import sinon from "sinon"
import { StateController } from "../StateController"

describe("StateController active-task characterization", () => {
	afterEach(() => sinon.restore())

	function createHarness(options?: {
		status?: TaskStatus
		awaitingPlanResponse?: boolean
		lastWaitingCardId?: string
		withoutTask?: boolean
		initialMode?: "plan" | "act"
	}) {
		const events: string[] = []
		let mode = options?.initialMode ?? "act"
		const task = options?.withoutTask
			? undefined
			: ({
					ulid: "task-ulid",
					applyWorkingConfigurationUpdate: sinon
						.stub()
						.callsFake(async (patch: TaskWorkingConfigurationPatch, beforeCommit?: () => void | Promise<void>) => {
							apiModule.buildApiHandler({}, (patch.settings?.mode ?? mode) as "plan" | "act")
							events.push("validate-runtime")
							await beforeCommit?.()
							const previousMode = mode
							mode = patch.settings?.mode ?? mode
							events.push("commit-runtime")
							if (previousMode !== mode) {
								task!.taskState.pendingModeNotice = { mode }
								if (previousMode === "plan" && mode === "act" && task!.taskState.isAwaitingPlanResponse) {
									task!.taskState.didRespondToPlanAskBySwitchingMode = true
								}
							}
						}),
					submitCardResponse: sinon.stub().callsFake(async () => events.push("submit-card")),
					taskState: {
						status: options?.status ?? TaskStatus.COMPLETED,
						pendingModeNotice: undefined,
						isAwaitingPlanResponse: options?.awaitingPlanResponse ?? false,
						didRespondToPlanAskBySwitchingMode: false,
						lastWaitingCardId: options?.lastWaitingCardId,
					},
					get stateView() {
						return this.taskState
					},
				} as any)
		const stateManager = {
			setGlobalState: sinon.stub().callsFake(() => events.push("persist-global-mode")),
			setSessionOverride: sinon.stub().callsFake(() => events.push("set-session-mode")),
			getSystemDefaultSettingsKey: sinon.stub().returns("act"),
			getGlobalSettingsKey: sinon.stub().returns("act"),
			hasSessionOverride: sinon.stub().returns(false),
			clearSessionOverride: sinon.stub().callsFake(() => events.push("clear-session-mode")),
		} as any
		const postStateToWebviewFn = sinon.stub().callsFake(async () => events.push("publish-state"))
		const cancelTaskFn = sinon.stub().callsFake(async () => events.push("cancel-task"))
		const buildApiHandlerFn = sinon.stub() as any
		const captureModeSwitchFn = sinon.stub().callsFake(() => events.push("capture-telemetry"))
		const controller = new StateController({
			stateManager,
			get task() {
				return task
			},
			buildApiHandlerFn,
			postStateToWebviewFn,
			cancelTaskFn,
			captureModeSwitchFn,
		})
		return {
			controller,
			task,
			stateManager,
			postStateToWebviewFn,
			cancelTaskFn,
			buildApiHandlerFn,
			captureModeSwitchFn,
			events,
		}
	}

	beforeEach(() => sinon.stub(apiModule, "buildApiHandler").returns({} as any))

	it("commits the selected mode before publishing and cancelling an active streaming task", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })

		const result = await harness.controller.togglePlanActMode("plan")

		result.should.equal(false)
		sinon.assert.calledOnce(harness.task!.applyWorkingConfigurationUpdate)
		harness.task!.taskState.pendingModeNotice.mode.should.equal("plan")
		sinon.assert.calledOnce(harness.cancelTaskFn)
		harness.events.indexOf("persist-global-mode").should.be.lessThan(harness.events.indexOf("commit-runtime"))
		harness.events.indexOf("commit-runtime").should.be.lessThan(harness.events.indexOf("publish-state"))
		harness.events.indexOf("publish-state").should.be.lessThan(harness.events.indexOf("cancel-task"))
	})

	it("turns a waiting Plan response into an approval only after the Task transition", async () => {
		const harness = createHarness({
			status: TaskStatus.AWAITING_USER_INPUT,
			awaitingPlanResponse: true,
			initialMode: "plan",
			lastWaitingCardId: "plan-card",
		})

		const result = await harness.controller.togglePlanActMode("act", {
			message: "approved plan",
			images: ["image"],
			files: ["file"],
		})

		result.should.equal(true)
		harness.task!.taskState.pendingModeNotice.mode.should.equal("act")
		harness.task!.taskState.didRespondToPlanAskBySwitchingMode.should.equal(true)
		sinon.assert.calledOnceWithExactly(
			harness.task!.submitCardResponse,
			"plan-card",
			DiracAskResponse.APPROVE,
			"approved plan",
			["image"],
			["file"],
		)
		sinon.assert.notCalled(harness.cancelTaskFn)
		harness.events.indexOf("commit-runtime").should.be.lessThan(harness.events.indexOf("publish-state"))
		harness.events.indexOf("publish-state").should.be.lessThan(harness.events.indexOf("submit-card"))
	})

	it("persists a mode selection without a Task runtime when no task exists", async () => {
		const harness = createHarness({ withoutTask: true })

		const result = await harness.controller.togglePlanActMode("plan")

		result.should.equal(false)
		sinon.assert.calledWithExactly(harness.stateManager.setGlobalState, "mode", "plan")
		sinon.assert.calledWithExactly(harness.stateManager.setSessionOverride, "mode", "plan")
		sinon.assert.calledWithExactly(harness.captureModeSwitchFn, "0", "plan")
		sinon.assert.notCalled(harness.cancelTaskFn)
	})

	it("YOLO mode switching commits Act without cancelling or capturing a normal mode event", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })

		const result = await harness.controller.toggleActModeForYoloMode()

		result.should.equal(true)
		sinon.assert.calledWithExactly(harness.stateManager.setGlobalState, "mode", "act")
		sinon.assert.calledWithExactly(harness.stateManager.setSessionOverride, "mode", "act")
		sinon.assert.calledOnce(harness.task!.applyWorkingConfigurationUpdate)
		sinon.assert.notCalled(harness.cancelTaskFn)
		sinon.assert.notCalled(harness.captureModeSwitchFn)
	})

	it("does not persist, publish, or capture telemetry when candidate construction fails", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })
		;(apiModule.buildApiHandler as sinon.SinonStub).throws(new Error("invalid mode runtime"))

		await harness.controller.togglePlanActMode("plan").should.be.rejectedWith("invalid mode runtime")

		sinon.assert.notCalled(harness.stateManager.setGlobalState)
		sinon.assert.notCalled(harness.stateManager.setSessionOverride)
		sinon.assert.notCalled(harness.postStateToWebviewFn)
		sinon.assert.notCalled(harness.captureModeSwitchFn)
		sinon.assert.notCalled(harness.cancelTaskFn)
	})

	it("does not publish or capture telemetry when persistence fails", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })
		harness.stateManager.setGlobalState.throws(new Error("mode persistence failed"))

		await harness.controller.togglePlanActMode("plan").should.be.rejectedWith("Mode persistence and rollback both failed")

		harness.events.should.not.containEql("commit-runtime")
		sinon.assert.notCalled(harness.postStateToWebviewFn)
		sinon.assert.notCalled(harness.captureModeSwitchFn)
		sinon.assert.notCalled(harness.cancelTaskFn)
	})

	it("rolls back global and session mode when the session write throws after mutation", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })
		let globalMode = "act"
		let sessionMode: string | undefined = "act"
		harness.stateManager.getSystemDefaultSettingsKey.callsFake(() => globalMode)
		harness.stateManager.getGlobalSettingsKey.callsFake(() => sessionMode ?? globalMode)
		harness.stateManager.hasSessionOverride.returns(true)
		harness.stateManager.setGlobalState.callsFake((_key: string, value: string) => {
			globalMode = value
			harness.events.push("persist-global-mode")
		})
		harness.stateManager.setSessionOverride.onFirstCall().callsFake((_key: string, value: string) => {
			sessionMode = value
			throw new Error("session mode write failed")
		})
		harness.stateManager.setSessionOverride.onSecondCall().callsFake((_key: string, value: string) => {
			sessionMode = value
		})

		await harness.controller.togglePlanActMode("plan").should.be.rejectedWith("session mode write failed")

		globalMode.should.equal("act")
		sessionMode!.should.equal("act")
		harness.events.should.not.containEql("commit-runtime")
		sinon.assert.notCalled(harness.postStateToWebviewFn)
	})
})
