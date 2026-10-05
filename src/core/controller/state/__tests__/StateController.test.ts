import "should"
import { TaskStatus } from "@shared/ExtensionMessage"
import sinon from "sinon"
import { StateController } from "../StateController"

describe("StateController", () => {
	afterEach(() => sinon.restore())

	function createController(status: TaskStatus) {
		const task = {
			ulid: "task-ulid",
			applyWorkingConfigurationUpdate: sinon.stub().callsFake(async (_patch, beforeCommit) => {
				await beforeCommit?.()
			}),
			taskState: {
				status,
				pendingModeNotice: undefined,
				isAwaitingPlanResponse: false,
			},
			get stateView() {
				return this.taskState
			},
		} as any
		const stateManager = {
			getSystemDefaultSettingsKey: sinon.stub().returns("act"),
			setGlobalState: sinon.stub(),
			setSessionOverride: sinon.stub(),
			hasSessionOverride: sinon.stub().returns(false),
			clearSessionOverride: sinon.stub(),
		} as any
		const postStateToWebviewFn = sinon.stub().resolves()
		const cancelTaskFn = sinon.stub().resolves()
		const buildApiHandlerFn = sinon.stub() as any
		const captureModeSwitchFn = sinon.stub()

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

		return { controller, task, stateManager, postStateToWebviewFn, cancelTaskFn }
	}

	it("switches mode without cancelling a completed task", async () => {
		const { controller, task, stateManager, postStateToWebviewFn, cancelTaskFn } = createController(TaskStatus.COMPLETED)

		const sentMessage = await controller.togglePlanActMode("plan")

		sentMessage.should.equal(false)
		sinon.assert.calledWith(stateManager.setGlobalState, "mode", "plan")
		sinon.assert.calledWith(stateManager.setSessionOverride, "mode", "plan")
		sinon.assert.calledOnce(postStateToWebviewFn)
		sinon.assert.calledOnce(task.applyWorkingConfigurationUpdate)
		sinon.assert.notCalled(cancelTaskFn)
	})

	it("still cancels an active task when switching mode", async () => {
		const { controller, cancelTaskFn } = createController(TaskStatus.STREAMING_TEXT)

		await controller.togglePlanActMode("plan")

		sinon.assert.calledOnce(cancelTaskFn)
	})
})
