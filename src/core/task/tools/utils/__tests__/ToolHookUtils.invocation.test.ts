import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as HookExecutor from "@core/hooks/hook-executor"
import { PreToolUseHookCancellationError } from "@core/hooks/PreToolUseHookCancellationError"
import { ToolExecutorCoordinator } from "../../ToolExecutorCoordinator"
import { createMockTaskConfig } from "../../__tests__/helpers/mockTaskConfig"
import { ToolHookUtils } from "../ToolHookUtils"

const block = { type: "tool_use" as const, name: "fixture", params: {} }

describe("ToolHookUtils invocation ownership", () => {
	afterEach(() => sinon.restore())

	it("returns pre-tool context as invocation effects without mutating turn content", async () => {
		const { config, taskState } = createMockTaskConfig({ overrides: { hooksEnabled: true } })
		sinon.stub(HookExecutor, "executeHook").resolves({ wasCancelled: false, contextModification: "WORKSPACE_RULES: Keep focused\nUse tests" })
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool({
			spec: () => ({ id: "fixture", name: "fixture", description: "test" }),
			supportedSurfaces: () => ["all"],
			processCall: async () => "done",
		})
		const result = await coordinator.execute(config, block)
		assert.deepEqual(result.effects.context, [{ type: "text", text: '<hook_context source="PreToolUse" type="workspace_rules">\nKeep focused\nUse tests\n</hook_context>' }])
		assert.deepEqual(taskState.userMessageContent, [])
	})

	it("routes pre-tool hook output through the originating invocation messenger", async () => {
		const { config, taskMessenger } = createMockTaskConfig({ overrides: { hooksEnabled: true } })
		const context = { executionId: "originating-execution", signal: new AbortController().signal, hooksEnabled: true, hookModel: { provider: "unknown", slug: "test-model" } }
		Object.defineProperty(config, "messengerContext", { value: context })
		const scopedMessenger = { marker: "scoped-hook-messenger" }
		const forInvocation = sinon.stub().returns(scopedMessenger)
		Object.defineProperty(taskMessenger, "forInvocation", { value: forInvocation })
		const executeHook = sinon.stub(HookExecutor, "executeHook").resolves({ wasCancelled: false })
		await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		sinon.assert.calledOnceWithExactly(forInvocation, context)
		assert.equal(executeHook.firstCall.args[0].messenger, scopedMessenger)
	})

	it("does not attach blank hook context", async () => {
		const { config } = createMockTaskConfig({ overrides: { hooksEnabled: true } })
		config.invocationEffects = { consecutiveMistakeCount: 0 }
		sinon.stub(HookExecutor, "executeHook").resolves({ wasCancelled: false, contextModification: "  \n " })
		await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		assert.equal(config.invocationEffects.context, undefined)
	})

	it("forwards invocation cancellation without cancelling its root or siblings", async () => {
		const { config, callbacks } = createMockTaskConfig({ overrides: { hooksEnabled: true } })
		const controller = new AbortController()
		Object.defineProperty(config, "execution", { value: { signal: controller.signal } })
		const execute = sinon.stub(HookExecutor, "executeHook").resolves({ cancel: true, wasCancelled: true })
		await assert.rejects(ToolHookUtils.runPreToolUseIfEnabled(config, block), PreToolUseHookCancellationError)
		sinon.assert.calledWithMatch(execute, { signal: controller.signal })
		sinon.assert.notCalled(callbacks.cancelTask as sinon.SinonStub)
	})

	it("returns explicit hook-requested task cancellation to the owner", async () => {
		const { config, callbacks } = createMockTaskConfig({ overrides: { hooksEnabled: true } })
		config.invocationEffects = { consecutiveMistakeCount: 0 }
		sinon.stub(HookExecutor, "executeHook").resolves({ cancel: true, wasCancelled: false })
		await assert.rejects(ToolHookUtils.runPreToolUseIfEnabled(config, block), PreToolUseHookCancellationError)
		assert.equal(config.invocationEffects.cancelTask, true)
		sinon.assert.notCalled(callbacks.cancelTask as sinon.SinonStub)
	})
})
