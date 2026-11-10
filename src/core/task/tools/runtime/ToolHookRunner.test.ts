import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as hooks from "@core/hooks/hook-executor"
import type { ToolUse } from "@core/assistant-message"
import { ToolHookRunner } from "./ToolHookRunner"

const block = { type: "tool_use", name: "read_file", params: { paths: ["file"] }, isComplete: true } as ToolUse
const api = { getModel: () => ({ id: "test", info: {} }) } as never

function runner() {
	const createCard = sinon.stub().resolves({ finalize: sinon.stub().resolves() })
	return {
		createCard,
		hooks: new ToolHookRunner({} as never, { createCard } as never, "task", async () => { }, async () => { }),
	}
}

describe("ToolHookRunner execution effects", () => {
	afterEach(() => sinon.restore())

	it("returns formatted context without borrowing any TaskState turn buffer", async () => {
		sinon.stub(hooks, "executeHook").resolves({ contextModification: "FILES: original\nsecond", wasCancelled: false })
		const instance = runner()
		const effect = await instance.hooks.runPostToolUseHook(block, "result", true, Date.now(), true, api, "anthropic")
		assert.equal(effect.cancelled, false)
		assert.deepEqual(effect.context, { type: "text", text: '<hook_context source="PostToolUse" type="files">\noriginal\nsecond\n</hook_context>' })
		sinon.assert.notCalled(instance.createCard)
	})

	it("does not turn execution-signal cancellation into a task cancellation effect", async () => {
		const controller = new AbortController()
		sinon.stub(hooks, "executeHook").callsFake(async (options) => {
			assert.equal(options.signal, controller.signal)
			controller.abort(new Error("execution cancelled"))
			return { cancel: true, wasCancelled: true }
		})
		const instance = runner()
		await assert.rejects(() => instance.hooks.runPostToolUseHook(block, "result", true, Date.now(), true, api, "anthropic", controller.signal), /execution cancelled/)
		sinon.assert.notCalled(instance.createCard)
	})

	it("routes post-hook output and cancellation cards through the originating invocation facade", async () => {
		const execute = sinon.stub(hooks, "executeHook").resolves({ cancel: true, wasCancelled: false })
		const context = { executionId: "old-execution", signal: new AbortController().signal, hooksEnabled: true, hookModel: { provider: "anthropic", slug: "original" } }
		const createCard = sinon.stub().resolves({ finalize: sinon.stub().resolves() })
		const facade = { createCard }
		const forInvocation = sinon.stub().returns(facade)
		const instance = new ToolHookRunner({} as never, { forInvocation } as never, "task", async () => { }, async () => { })
		await instance.runPostToolUseHook(block, "result", true, Date.now(), true, api, "anthropic", context.signal, context)
		sinon.assert.calledWithExactly(forInvocation, context)
		assert.equal(execute.firstCall.args[0].messenger, facade)
		sinon.assert.calledOnce(createCard)
	})

	it("preserves an explicit hook-requested task cancellation", async () => {
		sinon.stub(hooks, "executeHook").resolves({ cancel: true, errorMessage: "stop", wasCancelled: false })
		const instance = runner()
		assert.deepEqual(await instance.hooks.runPostToolUseHook(block, "result", true, Date.now(), true, api, "anthropic"), { cancelled: true })
		sinon.assert.calledOnce(instance.createCard)
	})
})
