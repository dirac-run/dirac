import { strict as assert } from "node:assert"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import type { TaskletControls } from "@core/task/tools/interfaces/IToolEnvironment"
import { describe, it } from "mocha"
import sinon from "sinon"
import { buildOrchestrationTrait } from "../OrchestrationTraitBuilder"

function controls() {
	return {
		start: sinon.stub().resolves({ id: "child" }),
		resume: sinon.stub().resolves({ id: "child" }),
		list: sinon.stub().returns([]),
		inspect: sinon.stub().returns({ id: "child" }),
		readTranscript: sinon.stub().resolves({ conversation: [], presentation: [] }),
		steer: sinon.stub().resolves({ id: "child", messageId: "guidance", accepted: true }),
		interrupt: sinon.stub().resolves({ id: "child" }),
		resolveInteraction: sinon.stub().resolves({ status: "resolved" }),
		sleep: sinon.stub().resolves({ reason: "timeout" }),
	}
}

function fixture() {
	const { config } = createMockTaskConfig()
	config.executionProfile = "standalone"
	const callbacks = controls()
	config.callbacks.tasklets = callbacks as TaskletControls
	return { config, callbacks }
}

describe("Tasklet environment control bindings", () => {
	for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup"] as const) {
		it(`forwards ${executionProfile} controls and exact child/request identity without joining assignments`, async () => {
			const { config, callbacks } = fixture()
			config.executionProfile = executionProfile
			const tasklets = buildOrchestrationTrait(config).tasklets!
			const input = { title: "investigate", prompt: "Find the cause" }
			assert.deepEqual(await tasklets.start(input), { id: "child" })
			assert.deepEqual(await tasklets.resume("child", "follow up"), { id: "child" })
			assert.deepEqual(tasklets.list(), [])
			assert.deepEqual(tasklets.inspect("child"), { id: "child" })
			assert.deepEqual(await tasklets.readTranscript("child"), { conversation: [], presentation: [] })
			assert.deepEqual(await tasklets.steer("child", "focus"), { id: "child", messageId: "guidance", accepted: true })
			await tasklets.interrupt("child", "stop")
			const decision = { operation: "reject" as const }
			assert.deepEqual(await tasklets.resolveInteraction("child", "request", decision), { status: "resolved" })
			const sleep = { taskletIds: ["child"], timeoutMs: 10 }
			assert.deepEqual(await tasklets.sleep(sleep), { reason: "timeout" })
			sinon.assert.calledOnceWithExactly(callbacks.start, input)
			sinon.assert.calledOnceWithExactly(callbacks.resume, "child", "follow up")
			sinon.assert.calledOnceWithExactly(callbacks.list)
			sinon.assert.calledOnceWithExactly(callbacks.inspect, "child")
			sinon.assert.calledOnceWithExactly(callbacks.readTranscript, "child")
			sinon.assert.calledOnceWithExactly(callbacks.steer, "child", "focus")
			sinon.assert.calledOnceWithExactly(callbacks.interrupt, "child", "stop")
			sinon.assert.calledOnceWithExactly(callbacks.resolveInteraction, "child", "request", decision)
			sinon.assert.calledOnceWithExactly(callbacks.sleep, sleep)
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

	it("preserves authority refusals and failed operations", async () => {
		const { config, callbacks } = fixture()
		const failure = new Error("request retired")
		callbacks.resolveInteraction.onFirstCall().resolves({ status: "requires_user_approval" })
		callbacks.resolveInteraction.onSecondCall().rejects(failure)
		const tasklets = buildOrchestrationTrait(config).tasklets!
		assert.deepEqual(await tasklets.resolveInteraction("child", "request", { operation: "approve" }), {
			status: "requires_user_approval",
		})
		await assert.rejects(tasklets.resolveInteraction("child", "request", { operation: "escalate" }), (error) => error === failure)
	})
})
