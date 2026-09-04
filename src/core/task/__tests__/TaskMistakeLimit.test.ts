import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus, TaskStatus } from "@shared/ExtensionMessage"
import { handleMistakeLimitReached, type TaskMistakeLimitContext } from "../TaskMistakeLimit"
import { TaskState } from "../TaskState"

describe("handleMistakeLimitReached", () => {
	it("returns didEndLoop: false when consecutiveMistakeCount is below threshold", async () => {
		const taskState = new TaskState()
		taskState.consecutiveMistakeCount = 1

		const ctx: TaskMistakeLimitContext = {
			taskState,
			settings: {
				maxConsecutiveMistakes: 3,
				yoloModeToggled: true,
			} as any,
			taskMessenger: {} as any,
		}

		const result = await handleMistakeLimitReached(ctx, [])
		assert.equal(result.didEndLoop, false)
		assert.notEqual(taskState.status, TaskStatus.CANCELLED)
	})

	it("cancels task, creates error card, calls postStateToWebview, and ends loop in yolo mode", async () => {
		const taskState = new TaskState()
		taskState.consecutiveMistakeCount = 3
		taskState.status = TaskStatus.EXECUTING_TOOL

		const finalizeStub = sinon.stub().resolves()
		const createCardStub = sinon.stub().resolves({
			finalize: finalizeStub,
		})
		const postStateStub = sinon.stub().resolves()

		const ctx: TaskMistakeLimitContext = {
			taskState,
			settings: {
				maxConsecutiveMistakes: 3,
				yoloModeToggled: true,
			} as any,
			taskMessenger: {
				createCard: createCardStub,
			} as any,
			postStateToWebview: postStateStub,
		}

		const result = await handleMistakeLimitReached(ctx, [])

		assert.equal(result.didEndLoop, true)
		assert.equal(taskState.status, TaskStatus.CANCELLED)
		assert.equal(createCardStub.callCount, 1)
		const createCardArgs = createCardStub.firstCall.args[0]
		assert.equal(createCardArgs.header, "Task Failed")
		assert.equal(createCardArgs.status, CardStatus.ERROR)
		assert.equal(finalizeStub.callCount, 1)
		assert.equal(finalizeStub.firstCall.args[0], CardStatus.ERROR)
		assert.equal(postStateStub.callCount, 1)
	})
})
