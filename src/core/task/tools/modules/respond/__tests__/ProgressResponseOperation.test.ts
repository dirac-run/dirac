import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { presentProgressResponse } from "../ProgressResponseOperation"

describe("progress response operation", () => {
	it("emits model text with explicit assistant authorship", async () => {
		const upsertText = sinon.stub().resolves()
		const env = { ui: { upsertText }, config: { mode: "act" } }

		await presentProgressResponse("Working on it.", env as any)

		assert.ok(upsertText.calledOnceWithExactly("Working on it.", false, "assistant"))
	})

	it("reports child progress to Dirac rather than claiming it was shown to the user", async () => {
		const upsertText = sinon.stub().resolves()
		const result = await presentProgressResponse("Found the cause.", {
			ui: { upsertText }, config: { mode: "act", executionProfile: "tasklet" },
		} as any)

		assert.match(result, /^Reported to Dirac\./)
		assert.doesNotMatch(result, /user/)
		assert.match(result, /respond 'complete'/)
		assert.ok(upsertText.calledOnceWithExactly("Found the cause.", false, "assistant"))
	})

	it("never recommends the Plan responder to a child even when the parent is in Plan mode", async () => {
		const result = await presentProgressResponse("Research complete.", {
			ui: { upsertText: sinon.stub().resolves() }, config: { mode: "plan", executionProfile: "tasklet" },
		} as any)

		assert.match(result, /respond 'complete'/)
		assert.doesNotMatch(result, /respond 'plan'/)
	})

	it("names the operation that ends the turn in the current mode", async () => {
		const upsertText = sinon.stub().resolves()

		const inPlan = await presentProgressResponse("Hi.", { ui: { upsertText }, config: { mode: "plan" } } as any)
		const inAct = await presentProgressResponse("Hi.", { ui: { upsertText }, config: { mode: "act" } } as any)

		assert.match(inPlan, /respond 'plan'/)
		assert.match(inAct, /respond 'complete'/)
		assert.match(inPlan, /^Shown to the user\./)
		assert.match(inAct, /^Shown to the user\./)
	})
})
