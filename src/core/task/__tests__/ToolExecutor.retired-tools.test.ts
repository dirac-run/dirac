import { strict as assert } from "node:assert"
import { LegacyResponseParameter, LegacyResponseTool, ResponseOperation } from "@shared/responseTool"
import { DiracDefaultTool } from "@shared/tools"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { ToolUse } from "../../assistant-message"
import { ToolExecutor } from "../ToolExecutor"
import type { ToolExecutionScopeContext } from "../tools/interfaces/ToolExecutionScope"

function harness() {
	const coordinator = {
		has: sinon.stub().callsFake((name: string) => name === DiracDefaultTool.RESPOND),
		execute: sinon.stub().resolves({ content: "response delivered", outcome: "success", effects: { mistake: "none" } }),
		bufferPartialToolUse: sinon.stub().resolves(),
	}
	const runtime = {
		requestId: "request",
		workingConfiguration: { settings: { hooksEnabled: false }, apiConfiguration: {} },
		api: { getModel: () => ({ id: "fixture-model" }) },
	}
	const config = { coordinator }
	const executor = Object.assign(Object.create(ToolExecutor.prototype), {
		coordinator,
		requestRuntime: () => runtime,
		asToolConfig: sinon.stub().returns(config),
		taskState: { didRejectTool: false, abortSignal: new AbortController().signal },
		browserSession: { closeBrowser: sinon.stub().resolves() },
		isPlanModeRestricted: sinon.stub().resolves(false),
		handleCompleteBlock: sinon.stub().resolves(),
		errorHandler: { handleError: sinon.stub().resolves() },
		resultPusher: { pushToolResult: sinon.stub().resolves() },
	})
	return { executor, coordinator }
}

function scope(): ToolExecutionScopeContext {
	return {
		identity: {
			executionId: "execution",
			owner: { rootTaskId: "root", taskId: "root", runId: "run" },
			requestId: "request",
			nativeToolCallId: "call",
			toolName: DiracDefaultTool.RESPOND,
			toolSnapshot: { requestId: "request", inventoryVersion: 1 },
		},
		signal: new AbortController().signal,
		appendOutput: async () => { },
		waiting: async () => { },
		resume: async () => { },
	}
}

const retiredCalls = [
	[LegacyResponseTool.PROGRESS, LegacyResponseParameter.MESSAGE],
	[LegacyResponseTool.COMPLETE, LegacyResponseParameter.RESULT],
	[LegacyResponseTool.COMPLETE, LegacyResponseParameter.RESPONSE],
	[LegacyResponseTool.PLAN, LegacyResponseParameter.RESPONSE],
	[LegacyResponseTool.QUESTION, LegacyResponseParameter.QUESTION],
] as const

describe("ToolExecutor response tool admission", () => {
	for (const [name, textParameter] of retiredCalls) {
		it(`rejects ${name} (${textParameter}) during invocation preparation without rewriting it`, () => {
			const { executor, coordinator } = harness()
			const block: ToolUse = { type: "tool_use", name, params: { [textParameter]: "retired text" } }
			const original = structuredClone(block)

			assert.throws(() => executor.prepareInvocation(block), { message: `Unknown tool: ${name}` })
			assert.deepEqual(block, original)
			sinon.assert.calledOnceWithExactly(coordinator.has, name)
			sinon.assert.notCalled(executor.asToolConfig)
			sinon.assert.notCalled(coordinator.execute)
		})

		it(`does not dispatch complete or partial ${name} (${textParameter}) as respond`, async () => {
			const { executor, coordinator } = harness()
			const block: ToolUse = { type: "tool_use", name, params: { [textParameter]: "retired text" } }
			const original = structuredClone(block)

			for (const isComplete of [true, false]) {
				assert.equal(await executor.execute(block, isComplete), false)
				assert.deepEqual(block, original)
			}
			sinon.assert.alwaysCalledWithExactly(coordinator.has, name)
			sinon.assert.notCalled(executor.asToolConfig)
			sinon.assert.notCalled(executor.handleCompleteBlock)
			sinon.assert.notCalled(coordinator.bufferPartialToolUse)
			sinon.assert.notCalled(coordinator.execute)
			sinon.assert.notCalled(executor.errorHandler.handleError)
		})
	}

	for (const operation of Object.values(ResponseOperation)) {
		it(`prepares and runs respond ${operation} without rewriting its arguments`, async () => {
			const { executor, coordinator } = harness()
			const block: ToolUse = {
				type: "tool_use",
				name: DiracDefaultTool.RESPOND,
				params: {
					operation,
					text: "current text",
					...(operation === ResponseOperation.QUESTION ? { options: ["A", "B"] } : {}),
				},
			}
			const prepared = executor.prepareInvocation(block)

			assert.deepEqual(prepared.block, block)
			assert.equal((await prepared.run(scope())).content, "response delivered")
			sinon.assert.calledOnce(coordinator.execute)
			assert.deepEqual(coordinator.execute.firstCall.args[1], block)
		})

		it(`dispatches current respond ${operation} through execution`, async () => {
			const { executor } = harness()
			const block: ToolUse = {
				type: "tool_use",
				name: DiracDefaultTool.RESPOND,
				params: { operation, text: "current text" },
			}

			assert.equal(await executor.execute(block), true)
			sinon.assert.calledOnce(executor.handleCompleteBlock)
			assert.equal(executor.handleCompleteBlock.firstCall.args[0], block)
			sinon.assert.notCalled(executor.errorHandler.handleError)
		})
	}
})
