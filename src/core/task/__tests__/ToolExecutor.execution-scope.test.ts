import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ToolExecutor } from "../ToolExecutor"
import { TaskState } from "../TaskState"
import { createTaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import { TASK_CALLBACKS_KEYS } from "../tools/utils/ToolConstants"
import type { TaskConfig } from "../tools/types/TaskConfig"
import type { ToolExecutionScopeContext } from "../tools/interfaces/ToolExecutionScope"
import type { ToolUse } from "@core/assistant-message"

function configuration(mode: "plan" | "act", revision: number) {
	return createTaskWorkingConfiguration({
		revision,
		settings: { mode, strictPlanModeEnabled: true, hooksEnabled: false, autoApprovalSettings: { actions: {} } } as any,
		apiConfiguration: { apiProvider: "anthropic" } as any,
		workspaceConfiguration: {} as any,
		executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
	})
}

function harness(mode: "plan" | "act" = "act") {
	let current = configuration(mode, 1)
	let runtime = createTaskRequestRuntime(current, { getModel: () => ({ id: "origin-model", info: {} }) } as any, "origin")
	const origin = runtime
	const state = new TaskState()
	const coordinator = { has: () => true, execute: sinon.stub().resolves({ content: "done", outcome: "success", effects: { mistake: "reset" } }) }
	const executor = Object.assign(Object.create(ToolExecutor.prototype), {
		executionProfile: "standalone",
		taskState: state,
		requestRuntime: () => runtime,
		getCurrentWorkingConfiguration: () => current,
		commandPermissionController: {},
		coordinator,
		createUtilityRunner: sinon.stub(),
		withTaskMutationAuthorization: sinon.stub().callsFake(async (_origin, _tool, operation) => operation()),
	}) as Record<string, any>
	for (const key of TASK_CALLBACKS_KEYS) {
		if (typeof executor[key] !== "function") executor[key] = sinon.stub()
	}
	return {
		executor, state, coordinator, origin,
		next(mode: "plan" | "act") {
			current = configuration(mode, 2)
			runtime = createTaskRequestRuntime(current, { getModel: () => ({ id: "next-model", info: {} }) } as any, "next")
			executor.coordinator = { has: () => true, execute: sinon.stub().rejects(new Error("wrong implementation")) }
		},
	}
}

function scope(toolName: string): ToolExecutionScopeContext {
	return {
		identity: {
			executionId: "execution", owner: { rootTaskId: "root", taskId: "root", runId: "run" },
			requestId: "origin", nativeToolCallId: "call", toolName,
			toolSnapshot: { requestId: "origin", inventoryVersion: 1 },
		},
		signal: new AbortController().signal,
		appendOutput: async () => { }, waiting: async () => { }, resume: async () => { },
	}
}

function call(name = "read_file"): ToolUse {
	return { type: "tool_use", name, params: { paths: ["original.ts"] }, isComplete: true } as ToolUse
}

describe("ToolExecutor captured invocations", () => {
	it("pins implementation, arguments and model attribution without writing into a later turn", async () => {
		const { executor, coordinator, state, next } = harness()
		const block = call()
		const prepared = executor.prepareInvocation(block)
		block.params.paths = ["changed.ts"]
		next("act")
		state.userMessageContent = [{ type: "text", text: "later turn" }]
		const result = await prepared.run(scope("read_file"))
		assert.equal(result.content, "done")
		assert.deepEqual(state.userMessageContent, [{ type: "text", text: "later turn" }])
		assert.equal(state.totalToolCallCount, 0)
		const [config, captured] = coordinator.execute.firstCall.args as [TaskConfig, ToolUse]
		assert.equal(config.model.id, "origin-model")
		assert.deepEqual(captured.params.paths, ["original.ts"])
		assert.equal(config.execution?.identity.executionId, "execution")
		assert.equal(config.messengerContext?.executionId, "execution")
		assert.equal(config.messengerContext?.hookModel.slug, "origin-model")
		assert.equal(config.messengerContext?.hooksEnabled, false)
	})

	for (const initialMode of ["plan", "act"] as const) {
		it(`allows read-only work from ${initialMode} under current strict Plan authority`, async () => {
			const { executor, coordinator, next } = harness(initialMode)
			const prepared = executor.prepareInvocation(call())
			next("plan")
			assert.equal((await prepared.run(scope("read_file"))).content, "done")
			sinon.assert.calledOnce(coordinator.execute)
		})
	}

	it("retains originating Plan restrictions after a later Act request", async () => {
		const { executor, coordinator, next } = harness("plan")
		const prepared = executor.prepareInvocation(call("edit_file"))
		next("act")
		await assert.rejects(() => prepared.run(scope("edit_file")), /Plan Mode/)
		sinon.assert.notCalled(coordinator.execute)
	})

	it("rechecks current authority after an admitted Act operation has waited", async () => {
		const { executor, coordinator, next } = harness()
		const prepared = executor.prepareInvocation(call("edit_file"))
		next("plan")
		await assert.rejects(() => prepared.run(scope("edit_file")), /Plan Mode/)
		sinon.assert.notCalled(coordinator.execute)
	})

	it("pins delayed utility callbacks to the originating API configuration", async () => {
		const { executor, coordinator, origin, next } = harness()
		await executor.prepareInvocation(call()).run(scope("read_file"))
		const config = coordinator.execute.firstCall.args[0] as TaskConfig
		next("act")
		const selection = { provider: "openai" as const, modelId: "utility" }
		config.callbacks.createUtilityModelRunner(selection)
		sinon.assert.calledWithExactly(executor.createUtilityRunner, selection, undefined, origin.workingConfiguration.apiConfiguration)
	})

	it("applies user rejection only at the legacy synchronous turn boundary", async () => {
		const { executor, coordinator, state, origin } = harness()
		coordinator.execute.resolves({ content: "skipped", outcome: "cancelled", effects: { mistake: "none", userInput: { message: "stop this" } } })
		const prepared = executor.prepareInvocation(call())
		await prepared.run(scope("read_file"))
		assert.equal(state.didRejectTool, false)
		assert.equal(state.pendingUserMessage, undefined)
		executor.resultPusher = { pushToolResult: sinon.stub().resolves() }
		const config = coordinator.execute.firstCall.args[0] as TaskConfig
		await executor.handleCompleteBlock(call(), config, origin)
		assert.equal(state.didRejectTool, true)
		assert.equal(state.pendingUserMessage, "stop this")
	})

	it("rejects mismatched scopes before invoking an implementation", () => {
		const { executor, coordinator } = harness()
		const prepared = executor.prepareInvocation(call())
		assert.throws(() => prepared.run(scope("edit_file")), /does not match/)
		sinon.assert.notCalled(coordinator.execute)
	})
})
