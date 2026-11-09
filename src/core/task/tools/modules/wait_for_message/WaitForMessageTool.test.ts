import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import { isDiscoveredToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { WaitForMessageTool, wait_for_message_spec } from "./WaitForMessageTool"
import { exposure } from "./tool"

function fixture(reason = "message") {
	const wait = sinon.stub().resolves({ reason })
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	const createCard = sinon.stub().resolves(card)
	const env = { orchestration: { agentWait: { wait } }, ui: { createCard } } as unknown as IToolEnvironment
	return { env, wait, card, createCard }
}

describe("WaitForMessageTool", () => {
	it("passes the finite default and returns a wake without consuming or completing work", async () => {
		const { env, wait, card } = fixture()
		assert.deepEqual(JSON.parse(await new WaitForMessageTool().processCall({}, env)), { reason: "message" })
		sinon.assert.calledOnceWithExactly(wait, { timeout_ms: 30000 })
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
	})
	it("accepts deadline endpoints and reports timeout/repeated-wait guidance", async () => {
		for (const timeout_ms of [1000, 300000]) {
			const { env, wait, card } = fixture("timeout")
			assert.deepEqual(JSON.parse(await new WaitForMessageTool().processCall({ timeout_ms }, env)), { reason: "timeout" })
			sinon.assert.calledOnceWithExactly(wait, { timeout_ms })
			assert.match(card.update.firstCall.args[0].body, /another wait requires fresh/)
		}
	})
	it("rejects unsupported fields and invalid finite deadlines before waiting", async () => {
		const { env, wait, createCard } = fixture()
		for (const input of [null, [], { from: "Dirac" }, { operation: "sleep" }, ...[null, 0, 999, 300001, 1000.5, "1000", NaN].map((timeout_ms) => ({ timeout_ms }))]) {
			await assert.rejects(new WaitForMessageTool().processCall(input, env))
		}
		sinon.assert.notCalled(wait)
		sinon.assert.notCalled(createCard)
	})
	it("finalizes cancellation and runtime rejection without swallowing failures", async () => {
		const { env, wait, card } = fixture("cancelled")
		await new WaitForMessageTool().processCall({}, env)
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ABANDONED)
		wait.rejects(new Error("Structured input is pending"))
		await assert.rejects(new WaitForMessageTool().processCall({}, env), /Structured input/)
		assert.equal(card.finalize.lastCall.args[0], CardStatus.ERROR)
	})
	it("requires child capability and exposes no parent supervision", async () => {
		const { env, createCard } = fixture()
		delete (env.orchestration as { agentWait?: unknown }).agentWait
		await assert.rejects(new WaitForMessageTool().processCall({}, env), /only to an active child/)
		sinon.assert.notCalled(createCard)
		const tool = { spec: wait_for_message_spec, exposure } as DiscoveredTool
		assert.equal(isDiscoveredToolAvailableToTaskProfile("tasklet", tool), true)
		for (const profile of ["standalone", "goal_coordinator", "goal_followup"] as const) assert.equal(isDiscoveredToolAvailableToTaskProfile(profile, tool), false)
	})
})
