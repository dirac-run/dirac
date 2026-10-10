import { strict as assert } from "node:assert"
import type { DiracContent } from "@shared/messages/content"
import { describe, it } from "mocha"
import sinon from "sinon"
import { recursivelyMakeDiracRequests } from "../TaskRequestLoop"
import { TaskState } from "../TaskState"

function createContext() {
	const taskState = new TaskState()
	const prepareApiRequest = sinon.stub().callsFake(async ({ userContent }) => ({
		userContent,
		lastApiReqIndex: 0,
		isDirectResponse: true,
		didConsumeUserContent: true,
	}))
	const runCompaction = sinon.stub().resolves("Continuation of task B")
	const context = {
		taskState,
		requestRuntime: {
			requestId: "request-1",
			workingConfiguration: {
				settings: { mode: "act" },
				apiConfiguration: { actModeApiProvider: "anthropic" },
			},
			api: { getModel: () => ({ id: "model-1", info: {} }) },
		},
		messageStateHandler: { getLatestApiStatusMessage: sinon.stub().returns(undefined) },
		modelContextTracker: { recordModelUsage: sinon.stub().resolves() },
		enqueuePreRequestSteeringMessages: sinon.stub().resolves(),
		handleMistakeLimitReached: sinon.stub().callsFake(async (userContent) => ({ didEndLoop: false, userContent })),
		initializeCheckpoints: sinon.stub().resolves(),
		determineContextCompaction: sinon.stub().resolves(true),
		localConversationCompaction: { isAvailable: () => true, run: runCompaction },
		steeringContext: { taskState, withStateLock: async (callback: () => unknown) => callback() },
		apiConversationManager: { prepareApiRequest },
	}
	return { context, prepareApiRequest, runCompaction }
}

describe("TaskRequestLoop automatic condensation", () => {
	it("supplies the incoming prompt before API persistence and retains it after the continuation", async () => {
		const { context, prepareApiRequest, runCompaction } = createContext()
		const userContent: DiracContent[] = [
			{ type: "text", text: "<feedback>\nImplement task B\n</feedback>", isUserInput: true },
		]
		const originalContent = structuredClone(userContent)

		assert.equal(await recursivelyMakeDiracRequests(context as any, userContent), true)

		assert.equal(runCompaction.firstCall.args[0].pendingUserContent, userContent)
		assert.ok(runCompaction.calledBefore(prepareApiRequest))
		assert.deepEqual(prepareApiRequest.firstCall.args[0].userContent, [
			{ type: "text", text: "Continuation of task B" },
			...originalContent,
		])
		assert.equal(prepareApiRequest.firstCall.args[0].shouldCompact, false)
		assert.deepEqual(userContent, originalContent)
	})

	it("does not consume the incoming prompt when condensation fails", async () => {
		const { context, prepareApiRequest, runCompaction } = createContext()
		runCompaction.resolves(undefined)
		const userContent: DiracContent[] = [{ type: "text", text: "Task B", isUserInput: true }]

		assert.equal(await recursivelyMakeDiracRequests(context as any, userContent), true)
		assert.equal(prepareApiRequest.callCount, 0)
		assert.deepEqual(userContent, [{ type: "text", text: "Task B", isUserInput: true }])
	})
})
