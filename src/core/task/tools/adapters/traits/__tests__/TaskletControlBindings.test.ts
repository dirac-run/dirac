import { strict as assert } from "node:assert"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import type { TaskletControls, TaskletMessage } from "@core/task/tools/interfaces/IToolEnvironment"
import { describe, it } from "mocha"
import sinon from "sinon"
import { buildOrchestrationTrait } from "../OrchestrationTraitBuilder"

function fixture() {
	const { config } = createMockTaskConfig()
	config.executionProfile = "standalone"
	const callbacks = {
		start: sinon.stub().resolves({ id: "child" }),
		resume: sinon.stub().resolves({ id: "child" }),
		list: sinon.stub().returns({ items: [], totalItems: 0 }),
		inspect: sinon.stub().resolves({ items: [], totalItems: 0 }),
		message: sinon.stub().resolves([{ taskletId: "child", status: "resolved" }]),
		interrupt: sinon.stub().resolves({ id: "child" }),
		sleep: sinon.stub().resolves({ reason: "timeout" }),
	}
	config.callbacks.tasklets = callbacks as TaskletControls
	return { config, callbacks }
}

describe("Tasklet environment control bindings", () => {
	for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup"] as const) {
		it(`forwards ${executionProfile} controls and exact addressed messages without joining assignments`, async () => {
			const { config, callbacks } = fixture()
			config.executionProfile = executionProfile
			const tasklets = buildOrchestrationTrait(config).tasklets!
			const input = { type: "default", title: "investigate", prompt: "Find the cause" }
			assert.deepEqual(await tasklets.start(input), { id: "child" })
			assert.deepEqual(await tasklets.resume("child", "follow up"), { id: "child" })
			assert.deepEqual(tasklets.list(), { items: [], totalItems: 0 })
			const query = { view: "result" as const, callId: "call-1", cursor: "cursor" }
			assert.deepEqual(await tasklets.inspect("child", query), { items: [], totalItems: 0 })
			const messages: TaskletMessage[] = [
				{ taskletId: "child", type: "permission_decision", replyTo: "request", decision: "reject" },
			]
			assert.deepEqual(await tasklets.message(messages), [{ taskletId: "child", status: "resolved" }])
			await tasklets.interrupt("child", "stop")
			const sleep = { taskletIds: ["child"], timeoutMs: 10 }
			assert.deepEqual(await tasklets.sleep(sleep), { reason: "timeout" })
			sinon.assert.calledOnceWithExactly(callbacks.start, input)
			sinon.assert.calledOnceWithExactly(callbacks.resume, "child", "follow up")
			sinon.assert.calledOnceWithExactly(callbacks.list)
			sinon.assert.calledOnceWithExactly(callbacks.inspect, "child", query)
			sinon.assert.calledOnceWithExactly(callbacks.message, messages)
			sinon.assert.calledOnceWithExactly(callbacks.interrupt, "child", "stop")
			sinon.assert.calledOnceWithExactly(callbacks.sleep, sleep)
			for (const removed of ["steer", "resolveInteraction", "readTranscript"]) assert.equal(removed in tasklets, false)
		})
	}

	it("does not expose controls to tasklets even when callbacks are supplied", () => {
		const { config } = fixture()
		config.executionProfile = "tasklet"
		assert.equal(buildOrchestrationTrait(config).tasklets, undefined)
	})

	it("leaves controls absent without an owner binding", () => {
		const { config } = fixture()
		config.callbacks.tasklets = undefined
		assert.equal(buildOrchestrationTrait(config).tasklets, undefined)
	})

	it("preserves per-item authority refusals and failed operations", async () => {
		const { config, callbacks } = fixture()
		const failure = new Error("storage unavailable")
		callbacks.message.onFirstCall().resolves([{ taskletId: "child", status: "requires_user_approval" }])
		callbacks.message.onSecondCall().rejects(failure)
		const tasklets = buildOrchestrationTrait(config).tasklets!
		const messages: TaskletMessage[] = [
			{ taskletId: "child", type: "permission_decision", replyTo: "request", decision: "approve" },
		]
		assert.deepEqual(await tasklets.message(messages), [{ taskletId: "child", status: "requires_user_approval" }])
		await assert.rejects(tasklets.message(messages), (error) => error === failure)
	})
})
