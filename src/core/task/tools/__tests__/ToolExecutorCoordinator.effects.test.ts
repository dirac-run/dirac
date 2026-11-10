import { strict as assert } from "node:assert"
import { describe, it, afterEach } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { IToolEnvironment } from "../interfaces/IToolEnvironment"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { ToolSkippedByUserMessage } from "../types/ToolSkippedByUserMessage"
import { ToolHookUtils } from "../utils/ToolHookUtils"
import { PreToolUseHookCancellationError } from "@core/hooks/PreToolUseHookCancellationError"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import * as HookExecutor from "@core/hooks/hook-executor"
import { createMockTaskConfig } from "./helpers/mockTaskConfig"

function fixture(processCall: IDiracTool["processCall"], surfaces: ReturnType<IDiracTool["supportedSurfaces"]> = ["all"]) {
	const mock = createMockTaskConfig()
	mock.taskState.consecutiveMistakeCount = 4
	mock.taskState.pendingUserMessage = "existing message"
	mock.taskState.pendingUserImages = ["existing image"]
	mock.taskState.pendingUserFiles = ["existing file"]
	for (const key of ["consecutiveMistakeCount", "pendingUserMessage", "pendingUserImages", "pendingUserFiles"] as const) {
		const value = mock.taskState[key]
		Object.defineProperty(mock.taskState, key, {
			configurable: true,
			enumerable: true,
			get: () => value,
			set: () => { throw new Error(`Direct turn mutation: ${key}`) },
		})
	}
	const coordinator = new ToolExecutorCoordinator()
	coordinator.registerModularTool({
		spec: () => ({ id: "effect_tool", name: "effect_tool", description: "test" }),
		supportedSurfaces: () => surfaces,
		processCall,
	})
	const execute = () => coordinator.execute(mock.config, { type: "tool_use", name: "effect_tool", params: {} })
	return { ...mock, execute }
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

describe("ToolExecutorCoordinator invocation effects", () => {
	afterEach(() => sinon.restore())

	it("returns reset after success without writing turn state", async () => {
		const { execute, taskState } = fixture(async () => "done")
		assert.deepEqual(await execute(), { outcome: "success", content: "done", effects: { mistake: "reset" } })
		assert.equal(taskState.consecutiveMistakeCount, 4)
	})

	for (const delta of [1, 3]) {
		it(`collapses ${delta} tool-reported mistakes to one owner increment`, async () => {
			const { execute, taskState } = fixture(async (_args, env) => {
				const initial = env.orchestration.getTaskState("consecutiveMistakeCount")
				assert.equal(initial, 4)
				env.orchestration.setTaskState("consecutiveMistakeCount", initial + delta)
				assert.equal(env.orchestration.getTaskState("consecutiveMistakeCount"), initial + delta)
				return "invalid arguments"
			})
			assert.deepEqual(await execute(), { outcome: "failure", content: "invalid arguments", effects: { mistake: "increment" } })
			assert.equal(taskState.consecutiveMistakeCount, 4)
		})
	}

	it("returns an increment for execution failure without writing turn state", async () => {
		const { execute } = fixture(async () => { throw new Error("expected failure") })
		assert.deepEqual(await execute(), { outcome: "failure", content: "Execution failed: expected failure", effects: { mistake: "increment" } })
	})

	it("returns skipped user input, preserving turn state and finalizing only live cards", async () => {
		const { execute, taskState, taskMessenger } = fixture(async (_args, env) => {
			await env.ui.createCard({ header: "Waiting" })
			const complete = await env.ui.createCard({ header: "Complete" })
			await complete.finalize(CardStatus.SUCCESS)
			env.orchestration.setTaskState("consecutiveMistakeCount", 9)
			throw new ToolSkippedByUserMessage("new input", ["new image"], ["new file"])
		})
		const result = await execute()
		assert.equal(result.outcome, "cancelled")
		assert.match(result.content as string, /skipped by user/)
		assert.deepEqual(result.effects, { mistake: "none", userInput: { message: "new input", images: ["new image"], files: ["new file"] } })
		assert.equal(taskState.consecutiveMistakeCount, 4)
		assert.equal(taskState.pendingUserMessage, "existing message")
		assert.deepEqual(taskState.pendingUserImages, ["existing image"])
		assert.deepEqual(taskState.pendingUserFiles, ["existing file"])
		const live = await taskMessenger.createCard.firstCall.returnValue
		const complete = await taskMessenger.createCard.secondCall.returnValue
		sinon.assert.calledOnceWithExactly(live.finalize, CardStatus.SKIPPED, undefined)
		sinon.assert.calledOnceWithExactly(complete.finalize, CardStatus.SUCCESS, undefined)
	})

	it("returns no mistake effect for surface rejection", async () => {
		const processCall = sinon.stub().resolves("unexpected")
		const { execute } = fixture(processCall, ["ide"])
		const result = await execute()
		assert.equal(result.outcome, "failure")
		assert.match(result.content as string, /not supported/)
		assert.deepEqual(result.effects, { mistake: "none" })
		sinon.assert.notCalled(processCall)
	})

	it("returns no mistake effect for pre-tool cancellation", async () => {
		const processCall = sinon.stub().resolves("unexpected")
		sinon.stub(ToolHookUtils, "runPreToolUseIfEnabled").rejects(new PreToolUseHookCancellationError("blocked"))
		const { execute } = fixture(processCall)
		const result = await execute()
		assert.equal(result.outcome, "cancelled")
		assert.match(result.content as string, /Cancelled by pre-tool hook: blocked/)
		assert.deepEqual(result.effects, { mistake: "none" })
		sinon.assert.notCalled(processCall)
	})

	it("does not publish effects before processCall cleanup settles", async () => {
		const startedCleanup = deferred()
		const cleanup = deferred()
		const { execute } = fixture(async (_args, _env: IToolEnvironment) => {
			try { throw new Error("expected failure") } finally {
				startedCleanup.resolve()
				await cleanup.promise
			}
		})
		let settled = false
		const execution = execute().then((result) => { settled = true; return result })
		await startedCleanup.promise
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(settled, false)
		cleanup.resolve()
		assert.equal((await execution).effects.mistake, "increment")
	})

	it("isolates mistake reporting between concurrent invocations", async () => {
		const firstStarted = deferred()
		const finishFirst = deferred()
		let calls = 0
		const { execute } = fixture(async (_args, env) => {
			if (++calls === 1) {
				env.orchestration.setTaskState("consecutiveMistakeCount", 5)
				firstStarted.resolve()
				await finishFirst.promise
			}
			return "done"
		})
		const first = execute()
		await firstStarted.promise
		assert.equal((await execute()).effects.mistake, "reset")
		finishFirst.resolve()
		assert.equal((await first).effects.mistake, "increment")
	})

	it("propagates hook cleanup failure after scoped cancellation instead of returning tool content", async () => {
		const controller = new AbortController()
		const failure = new HookCleanupError([new Error("resource still owned")], "Hook cleanup failed")
		sinon.stub(HookExecutor, "executeHook").rejects(failure)
		const { config, execute } = fixture(async (_args, env) => {
			controller.abort(new Error("invocation stopped"))
			await env.orchestration.runHook("Notification", {})
			return "unreachable"
		})
		Object.defineProperty(config, "execution", { value: { signal: controller.signal } })
		await assert.rejects(execute(), (error) => error === failure)
	})
})
