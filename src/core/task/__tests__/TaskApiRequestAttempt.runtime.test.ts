import { strict as assert } from "node:assert"
import * as modelPresets from "@core/models/modelProviderPresets"
import { TaskStatus } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import { StreamingMetricsManager } from "../StreamingMetricsManager"
import { attemptApiRequest } from "../TaskApiRequestAttempt"
import * as requestBuilder from "../TaskRequestBuilder"
import * as requestOutcome from "../TaskRequestOutcome"
import { TaskState } from "../TaskState"
import * as steering from "../TaskSteering"

function failingStream(error: Error) {
	return {
		[Symbol.asyncIterator]() {
			return {
				next: sinon.stub().rejects(error),
			}
		},
	}
}

function emptyStream() {
	return {
		[Symbol.asyncIterator]() {
			return {
				next: sinon.stub().resolves({ done: true, value: undefined }),
			}
		},
	}
}

describe("TaskApiRequestAttempt request runtime", () => {
	it("reuses the exact request runtime and API handler across an automatic retry", async () => {
		const sandbox = sinon.createSandbox()
		try {
			const requestRuntime = {
				requestId: "request-1",
				workingConfiguration: { revision: 4, settings: { mode: "act" } },
				api: {
					getModel: () => ({ id: "request-model", info: {} }),
					createMessage: sandbox.stub(),
				},
			} as any
			requestRuntime.api.createMessage.onFirstCall().returns(failingStream(new Error("retry me")))
			requestRuntime.api.createMessage.onSecondCall().returns(emptyStream())

			const build = sandbox.stub(requestBuilder, "buildApiRequestParams").resolves({
				systemPrompt: "request prompt",
				toolSnapshot: { nativeTools: [{ name: "request-tool" }] },
				contextManagementMetadata: { truncatedConversationHistory: [{ role: "user", content: "request" }] },
				providerInfo: {
					providerId: "anthropic",
					model: { id: "request-model", info: {} },
					mode: "act",
				},
			} as any)
			sandbox.stub(requestOutcome, "handleApiRequestError").resolves(true)
			sandbox.stub(steering, "appendQueuedSteeringToNextApiRequest").resolves()
			sandbox.stub(modelPresets, "recordSuccessfulModelProviderPreset")
			sandbox.stub(StreamingMetricsManager.prototype, "updateApiReqMsgFromMetrics").resolves()

			const ctx = {
				requestRuntime,
				postStateToWebview: sandbox.stub().resolves(),
				messageStateHandler: { updateDiracMessage: sandbox.stub().resolves() },
				taskState: new TaskState(),
				steeringContext: {},
				apiConversationManager: {
					prepareProviderConversationDispatch: sandbox
						.stub()
						.callsFake(async ({ systemPrompt, tools, truncatedMessages }) => ({
							messages: truncatedMessages,
							options: { systemPrompt, tools },
						})),
				},
				stateManager: {},
			} as any

			const chunks = []
			for await (const chunk of attemptApiRequest(ctx, 0, 0, false)) chunks.push(chunk)

			sinon.assert.calledTwice(ctx.postStateToWebview)
			assert.equal(ctx.taskState.isWaitingForFirstChunk, false)
			assert.deepEqual(chunks, [])
			sinon.assert.calledTwice(build)
			assert.equal(build.firstCall.args[1], requestRuntime)
			assert.equal(build.secondCall.args[1], requestRuntime)
			sinon.assert.calledTwice(requestRuntime.api.createMessage)
			assert.equal(requestRuntime.api.createMessage.firstCall.args[0], "request prompt")
			assert.equal(requestRuntime.api.createMessage.secondCall.args[0], "request prompt")
			assert.equal(requestRuntime.api.createMessage.firstCall.args[2][0].name, "request-tool")
			assert.equal(requestRuntime.api.createMessage.secondCall.args[2][0].name, "request-tool")
		} finally {
			sandbox.restore()
		}
	})
	it("publishes the waiting state before requesting a delayed first chunk", async () => {
		const sandbox = sinon.createSandbox()
		try {
			let finishFirstChunk!: (chunk: { done: true; value: undefined }) => void
			let startedReading!: () => void
			const reading = new Promise<void>((resolve) => {
				startedReading = resolve
			})
			const next = sandbox.stub().callsFake(() => {
				startedReading()
				return new Promise((resolve) => {
					finishFirstChunk = resolve
				})
			})
			sandbox.stub(requestBuilder, "buildApiRequestParams").resolves({
				systemPrompt: "system",
				toolSnapshot: { nativeTools: [] },
				contextManagementMetadata: { truncatedConversationHistory: [] },
				providerInfo: { providerId: "deepseek", model: { id: "deepseek-flash", info: {} }, mode: "plan" },
			} as any)
			sandbox.stub(steering, "appendQueuedSteeringToNextApiRequest").resolves()
			sandbox.stub(StreamingMetricsManager.prototype, "updateApiReqMsgFromMetrics").resolves()
			const taskState = new TaskState()
			taskState.status = TaskStatus.BUILDING_REQUEST
			const publish = sandbox.stub().callsFake(async () => {
				assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
				sinon.assert.notCalled(next)
			})
			const ctx = {
				taskState,
				postStateToWebview: publish,
				requestRuntime: { api: { createMessage: () => ({ [Symbol.asyncIterator]: () => ({ next }) }) } },
				apiConversationManager: { prepareProviderConversationDispatch: async () => ({ messages: [], options: {} }) },
				messageStateHandler: { updateDiracMessage: sandbox.stub().resolves() },
			} as any
			const pending = attemptApiRequest(ctx, -1, 0).next()
			await reading
			sinon.assert.calledOnce(publish)
			assert.equal(taskState.isWaitingForFirstChunk, true)
			finishFirstChunk({ done: true, value: undefined })
			await pending
			assert.equal(taskState.isWaitingForFirstChunk, false)
		} finally {
			sandbox.restore()
		}
	})
})
