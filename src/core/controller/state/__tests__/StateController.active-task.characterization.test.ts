import "should"
import * as apiModule from "@core/api"
import type { TaskWorkingConfigurationPatch } from "@core/task/runtime/TaskWorkingConfiguration"
import type { ChatContent } from "@shared/ChatContent"
import { Task } from "@core/task"
import { TaskState } from "@core/task/TaskState"
import { PlanInteractionResponse } from "@shared/responseTool"
import { TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import sinon from "sinon"
import { StateController } from "../StateController"

describe("StateController active-task characterization", () => {
	afterEach(() => sinon.restore())

	function createHarness(options?: {
		status?: TaskStatus
		awaitingPlanResponse?: boolean
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
					.callsFake(async (patch: TaskWorkingConfigurationPatch, beforeCommit?: () => void | Promise<void>, content?: ChatContent) => {
						apiModule.buildApiHandler({}, (patch.settings?.mode ?? mode) as "plan" | "act")
						events.push("validate-runtime")
						await beforeCommit?.()
						const previousMode = mode
						mode = patch.settings?.mode ?? mode
						events.push("commit-runtime")
						const applyCommittedModeEffects = (Task.prototype as any).applyCommittedModeEffects
						applyCommittedModeEffects.call(task, previousMode, mode, content)
					}),
				submitCardResponse: sinon.stub().callsFake(async () => events.push("submit-card")),
				taskState: Object.assign(new TaskState(), {
					status: options?.status ?? TaskStatus.COMPLETED,
					isAwaitingPlanResponse: options?.awaitingPlanResponse ?? false,
				}),
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
		const buildApiHandlerFn = sinon.stub() as any
		const captureModeSwitchFn = sinon.stub().callsFake(() => events.push("capture-telemetry"))
		const controller = new StateController({
			stateManager,
			get task() {
				return task
			},
			buildApiHandlerFn,
			postStateToWebviewFn,
			captureModeSwitchFn,
		})
		return {
			controller,
			task,
			stateManager,
			postStateToWebviewFn,
			buildApiHandlerFn,
			captureModeSwitchFn,
			events,
		}
	}

	beforeEach(() => sinon.stub(apiModule, "buildApiHandler").returns({} as any))

	it("commits the selected mode before publishing an active streaming task without restarting it", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })

		const result = await harness.controller.togglePlanActMode("plan")

		result.should.equal(false)
		sinon.assert.calledOnce(harness.task!.applyWorkingConfigurationUpdate)
		harness.task!.taskState.pendingModeNotice.mode.should.equal("plan")
		harness.task!.taskState.pendingModeNotice.switched.should.equal(true)
		harness.events.indexOf("persist-global-mode").should.be.lessThan(harness.events.indexOf("commit-runtime"))
		harness.events.indexOf("commit-runtime").should.be.lessThan(harness.events.indexOf("publish-state"))
		sinon.assert.notCalled(harness.task!.submitCardResponse)
	})

	it("turns a waiting Plan response into an approval only after the Task transition", async () => {
		const harness = createHarness({
			status: TaskStatus.AWAITING_USER_INPUT,
			awaitingPlanResponse: true,
			initialMode: "plan",
		})

		const pending = {
			signal: new AbortController().signal,
			modeSwitchResponse: sinon.stub().callsFake((mode, content) => ({
				response: DiracAskResponse.APPROVE,
				action: DiracAskResponse.APPROVE,
				value: PlanInteractionResponse.MODE_TOGGLE,
				modeSwitch: mode,
				text: content?.message,
				images: content?.images,
				files: content?.files,
			})),
			response: undefined as any,
		}
		harness.task!.taskState.pendingCardInteractions.set("plan-card", pending)

		const result = await harness.controller.togglePlanActMode("act", {
			message: "approved plan",
			images: ["image"],
			files: ["file"],
		})

		result.should.equal(true)
		harness.task!.taskState.pendingModeNotice.mode.should.equal("act")
		pending.response.should.deepEqual({
			response: DiracAskResponse.APPROVE,
			action: DiracAskResponse.APPROVE,
			value: PlanInteractionResponse.MODE_TOGGLE,
			modeSwitch: "act",
			text: "approved plan",
			images: ["image"],
			files: ["file"],
		})
		sinon.assert.notCalled(harness.task!.submitCardResponse)
		harness.events.indexOf("commit-runtime").should.be.lessThan(harness.events.indexOf("publish-state"))
	})

	it("does not consume composer content for a no-op selection or an already answered wait", async () => {
		const harness = createHarness({ initialMode: "act" })
		const pending = {
			signal: new AbortController().signal,
			modeSwitchResponse: sinon.stub().returns({ action: "message", modeSwitch: "act" }),
			response: undefined as any,
		}
		harness.task!.taskState.pendingCardInteractions.set("card", pending)

		const unchanged = await harness.controller.togglePlanActMode("act", { message: "Keep my draft" })
		unchanged.should.equal(false)
		sinon.assert.notCalled(pending.modeSwitchResponse)
		pending.response = { action: "approve" }
		const answered = await harness.controller.togglePlanActMode("plan", { message: "Still keep it" })
		answered.should.equal(false)
		sinon.assert.notCalled(pending.modeSwitchResponse)
	})

	it("recognizes a captured response even if its wait unregisters before publication completes", async () => {
		const harness = createHarness({ initialMode: "act" })
		harness.task!.taskState.pendingCardInteractions.set("card", {
			signal: new AbortController().signal,
			modeSwitchResponse: (mode: string) => ({ action: "message", modeSwitch: mode }),
		})
		harness.postStateToWebviewFn.callsFake(async () => harness.task!.taskState.pendingCardInteractions.clear())

		const consumed = await harness.controller.togglePlanActMode("plan", { message: "Consumed" })
		consumed.should.equal(true)
		harness.task!.taskState.pendingCardInteractions.size.should.equal(0)
	})

	it("persists a mode selection without a Task runtime when no task exists", async () => {
		const harness = createHarness({ withoutTask: true })

		const result = await harness.controller.togglePlanActMode("plan")

		result.should.equal(false)
		sinon.assert.calledWithExactly(harness.stateManager.setGlobalState, "mode", "plan")
		sinon.assert.calledWithExactly(harness.stateManager.setSessionOverride, "mode", "plan")
		sinon.assert.calledWithExactly(harness.captureModeSwitchFn, "0", "plan")
	})

	it("YOLO mode switching commits Act without cancelling or capturing a normal mode event", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })

		const result = await harness.controller.toggleActModeForYoloMode()

		result.should.equal(true)
		sinon.assert.calledWithExactly(harness.stateManager.setGlobalState, "mode", "act")
		sinon.assert.calledWithExactly(harness.stateManager.setSessionOverride, "mode", "act")
		sinon.assert.calledOnce(harness.task!.applyWorkingConfigurationUpdate)
		sinon.assert.notCalled(harness.captureModeSwitchFn)
	})

	it("does not persist, publish, or capture telemetry when candidate construction fails", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })
		const buildApiHandler = apiModule.buildApiHandler as sinon.SinonStub
		buildApiHandler.throws(new Error("invalid mode runtime"))

		await harness.controller.togglePlanActMode("plan").should.be.rejectedWith("invalid mode runtime")

		sinon.assert.notCalled(harness.stateManager.setGlobalState)
		sinon.assert.notCalled(harness.stateManager.setSessionOverride)
		sinon.assert.notCalled(harness.postStateToWebviewFn)
		sinon.assert.notCalled(harness.captureModeSwitchFn)
	})

	it("does not publish or capture telemetry when persistence fails", async () => {
		const harness = createHarness({ status: TaskStatus.STREAMING_TEXT })
		harness.stateManager.setGlobalState.throws(new Error("mode persistence failed"))

		await harness.controller.togglePlanActMode("plan").should.be.rejectedWith("Mode persistence and rollback both failed")

		harness.events.should.not.containEql("commit-runtime")
		sinon.assert.notCalled(harness.postStateToWebviewFn)
		sinon.assert.notCalled(harness.captureModeSwitchFn)
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
