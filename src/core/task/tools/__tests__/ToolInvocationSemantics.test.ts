import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import { ToolExecutor } from "../../ToolExecutor"
import { SurfaceAdapter } from "../adapters/SurfaceAdapter"
import type { IDiracTool } from "../interfaces/IDiracTool"
import { ListFilesTool } from "../modules/list_files"
import { ReadFileTool } from "../modules/read_file/ReadFileTool"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { createMockTaskConfig } from "./helpers/mockTaskConfig"

function fixture(tool: IDiracTool, configure: (env: SurfaceAdapter) => void = () => { }) {
	const mock = createMockTaskConfig()
	const controller = new AbortController()
	Object.assign(mock.config, { execution: { signal: controller.signal, identity: { executionId: "test" } } })
	const coordinator = new ToolExecutorCoordinator({
		create: (config, name) => {
			const env = new SurfaceAdapter(config, name)
			configure(env)
			return env
		},
	})
	coordinator.registerModularTool(tool)
	mock.config.coordinator = coordinator
	return { ...mock, controller, coordinator }
}

function operation(processCall: IDiracTool["processCall"]): IDiracTool {
	return { spec: () => ({ id: "read_file", name: "read_file", description: "test" }), supportedSurfaces: () => ["all"], processCall }
}

const block = { type: "tool_use" as const, name: "read_file", params: {} }

describe("Tool invocation semantic outcomes", () => {
	afterEach(() => sinon.restore())

	it("reports real built-in missing arguments as failure without parsing the response", async () => {
		const h = fixture(new ListFilesTool())
		const result = await h.coordinator.execute(h.config, { ...block, name: "list_files", params: { paths: [] } })
		assert.equal(result.outcome, "failure")
		assert.equal(result.effects.mistake, "increment")
	})

	it("passes a returned validation failure to PostToolUse as unsuccessful", async () => {
		const h = fixture(new ListFilesTool())
		const postHook = sinon.stub().resolves({ cancelled: false })
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			taskState: h.taskState, hookRunner: { runPostToolUseHook: postHook },
		})
		await executor.runInvocation({ ...block, name: "list_files", params: { paths: [] } }, h.config, {
			workingConfiguration: { settings: { hooksEnabled: true, mode: "act" }, apiConfiguration: {} },
		})
		assert.equal(postHook.firstCall.args[2], false)
	})

	it("treats an empty successful listing as partial batch success", async () => {
		const h = fixture(new ListFilesTool(), (env) => {
			sinon.stub(env.workspace, "resolvePath").callsFake(async (requested) => ({ absolutePath: `/workspace/${requested}`, displayPath: requested }))
			sinon.stub(env.workspace, "listFiles").callsFake(async (path) => {
				if (path.endsWith("bad")) throw new Error("filesystem unavailable")
				return [[], false]
			})
		})
		const result = await h.coordinator.execute(h.config, { ...block, name: "list_files", params: { paths: ["bad", "empty"] } })
		assert.equal(result.outcome, "success")
		assert.equal(result.effects.mistake, "reset")
	})

	it("reports an operational failure independently of model mistakes and response wording", async () => {
		const h = fixture(operation(async (_args, env) => {
			env.orchestration.reportFailure()
			return "arbitrary structured diagnosis"
		}))
		h.taskState.consecutiveMistakeCount = 3
		const result = await h.coordinator.execute(h.config, block)
		assert.equal(result.outcome, "failure")
		assert.equal(result.effects.mistake, "none")
		assert.equal(h.taskState.consecutiveMistakeCount, 3)
	})

	it("does not infer failure from response text", async () => {
		const h = fixture(operation(async () => "Error is the name of this class, not an execution failure"))
		assert.equal((await h.coordinator.execute(h.config, block)).outcome, "success")
	})

	it("reports a real file-read access failure, but preserves partial batch success", async () => {
		const h = fixture(new ReadFileTool(), (env) => {
			sinon.stub(env.workspace, "resolvePath").callsFake(async (requested) => {
				if (requested === "missing") throw new Error("ENOENT")
				return { absolutePath: "/workspace/image.png", displayPath: "image.png" }
			})
			sinon.stub(env.workspace, "readRichFile").resolves({ text: "image", imageBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } } })
		})
		const failed = await h.coordinator.execute(h.config, { ...block, params: { paths: ["missing"] } })
		assert.equal(failed.outcome, "failure")
		assert.equal(failed.effects.mistake, "none")
		assert.equal((await h.coordinator.execute(h.config, { ...block, params: { paths: ["missing", "image.png"] } })).outcome, "success")
	})

	for (const hooksEnabled of [false, true]) {
		it(`returns settled cancellation without a mistake or post-hook failure (hooks=${hooksEnabled})`, async () => {
			const reason = new Error("invocation cancelled")
			const h = fixture(operation(async () => {
				h.controller.abort(reason)
				throw reason
			}))
			const postHook = sinon.stub().rejects(new Error("must not start"))
			const executor = Object.assign(Object.create(ToolExecutor.prototype), {
				taskState: h.taskState, hookRunner: { runPostToolUseHook: postHook },
			})
			const runtime = { workingConfiguration: { settings: { hooksEnabled } } }
			const result = await executor.runInvocation(block, h.config, runtime)
			assert.equal(result.outcome, "cancelled")
			assert.equal(result.effects.mistake, "none")
			sinon.assert.notCalled(postHook)
		})
	}

	it("preserves completed operation content when cancellation arrives before post-hook startup", async () => {
		const h = fixture(operation(async () => {
			h.controller.abort()
			return "write committed"
		}))
		const postHook = sinon.stub()
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			taskState: h.taskState, hookRunner: { runPostToolUseHook: postHook },
		})
		const result = await executor.runInvocation(block, h.config, { workingConfiguration: { settings: { hooksEnabled: true } } })
		assert.equal(result.outcome, "success")
		assert.equal(result.content, "write committed")
		sinon.assert.notCalled(postHook)
	})

	it("preserves operation results when the post-hook cooperatively cancels", async () => {
		const h = fixture(operation(async () => "operation complete"))
		const reason = new Error("cancelled hook")
		const postHook = sinon.stub().callsFake(async () => {
			h.controller.abort(reason)
			throw reason
		})
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			taskState: h.taskState, hookRunner: { runPostToolUseHook: postHook },
		})
		const result = await executor.runInvocation(block, h.config, {
			workingConfiguration: { settings: { hooksEnabled: true, mode: "act" }, apiConfiguration: {} },
		})
		assert.equal(result.content, "operation complete")
		assert.equal(result.outcome, "success")
		sinon.assert.calledOnce(postHook)
	})

	it("does not disguise actual cleanup failure as successful cancellation", async () => {
		const failure = new HookCleanupError([new Error("owned resource")], "cleanup failed")
		const h = fixture(operation(async () => {
			h.controller.abort()
			throw failure
		}))
		await assert.rejects(h.coordinator.execute(h.config, block), (error) => error === failure)
	})
})
