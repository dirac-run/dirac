import "should"
import sinon from "sinon"
import { TaskStatus } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { StateController } from "../StateController"

describe("StateController", () => {
	afterEach(() => sinon.restore())

	function createController(status: TaskStatus) {
		const task = {
			ulid: "task-ulid",
			api: undefined,
			taskState: {
				status,
				didSwitchToActMode: false,
				isAwaitingPlanResponse: false,
			},
		} as any
		const stateManager = {
			setGlobalState: sinon.stub(),
			setSessionOverride: sinon.stub(),
			getApiConfiguration: sinon.stub().returns({}),
		} as any
		const postStateToWebviewFn = sinon.stub().resolves()
		const cancelTaskFn = sinon.stub().resolves()
		const api = {} as any
		const buildApiHandlerFn = sinon.stub().returns(api) as any
		sinon.stub(telemetryService, "captureModeSwitch")

		const controller = new StateController({
			stateManager,
			get task() {
				return task
			},
			buildApiHandlerFn,
			postStateToWebviewFn,
			cancelTaskFn,
		})

		return { controller, task, stateManager, postStateToWebviewFn, cancelTaskFn, buildApiHandlerFn, api }
	}

	it("switches mode without cancelling a completed task", async () => {
		const { controller, task, stateManager, postStateToWebviewFn, cancelTaskFn, buildApiHandlerFn, api } = createController(
			TaskStatus.COMPLETED,
		)

		const sentMessage = await controller.togglePlanActMode("plan")

		sentMessage.should.equal(false)
		sinon.assert.calledWith(stateManager.setGlobalState, "mode", "plan")
		sinon.assert.calledWith(stateManager.setSessionOverride, "mode", "plan")
		sinon.assert.calledOnce(postStateToWebviewFn)
		sinon.assert.calledOnce(buildApiHandlerFn)
		task.api.should.equal(api)
		sinon.assert.notCalled(cancelTaskFn)
	})

	it("still cancels an active task when switching mode", async () => {
		const { controller, cancelTaskFn } = createController(TaskStatus.STREAMING_TEXT)

		await controller.togglePlanActMode("plan")

		sinon.assert.calledOnce(cancelTaskFn)
	})
})
