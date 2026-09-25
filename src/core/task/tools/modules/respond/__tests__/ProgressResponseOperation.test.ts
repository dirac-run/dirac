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

	it("names the operation that ends the turn in the current mode", async () => {
		const upsertText = sinon.stub().resolves()

		const inPlan = await presentProgressResponse("Hi.", { ui: { upsertText }, config: { mode: "plan" } } as any)
		const inAct = await presentProgressResponse("Hi.", { ui: { upsertText }, config: { mode: "act" } } as any)

		assert.match(inPlan, /respond 'plan'/)
		assert.match(inAct, /respond 'complete'/)
	})
})
