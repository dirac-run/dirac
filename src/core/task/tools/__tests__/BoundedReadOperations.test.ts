import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { SurfaceAdapter } from "../adapters/SurfaceAdapter"
import { ListFilesTool } from "../modules/list_files"
import { ReadFileTool } from "../modules/read_file/ReadFileTool"
import { UseSkillTool } from "../modules/use_skill/UseSkillTool"
import { ToolTimeoutError } from "../runtime/ToolExecutionDeadline"
import { createMockTaskConfig } from "./helpers/mockTaskConfig"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return { promise, resolve }
}

function fixture() {
	const mock = createMockTaskConfig()
	const controller = new AbortController()
	Object.assign(mock.config, { execution: { signal: controller.signal, identity: { executionId: "test" } } })
	return { ...mock, controller, env: new SurfaceAdapter(mock.config) }
}

describe("Bounded read operation ownership", () => {
	afterEach(() => sinon.restore())

	it("bounds list_files path observation without waiting for a stalled service query", async () => {
		const clock = sinon.useFakeTimers()
		const h = fixture()
		const query = deferred<{ absolutePath: string; displayPath: string }>()
		sinon.stub(h.env.workspace, "resolvePath").returns(query.promise)
		const listing = sinon.spy(h.env.workspace, "listFiles")
		const pending = new ListFilesTool().processCall({ paths: ["."] }, h.env)
		const rejection = assert.rejects(pending, ToolTimeoutError)
		await clock.tickAsync(30_001)
		await rejection
		query.resolve({ absolutePath: "/workspace", displayPath: "." })
		await clock.tickAsync(0)
		sinon.assert.notCalled(listing)
	})

	for (const stop of ["timeout", "cancel"] as const) {
		it(`forwards ${stop} to an owned listing and joins cleanup`, async () => {
			const clock = sinon.useFakeTimers()
			const h = fixture()
			const started = deferred<void>()
			const cleanup = deferred<void>()
			let signal!: AbortSignal
			sinon.stub(h.env.workspace, "resolvePath").resolves({ absolutePath: "/workspace", displayPath: "." })
			sinon.stub(h.env.workspace, "listFiles").callsFake(async (_path, _recursive, _limit, executionSignal) => {
				signal = executionSignal!
				started.resolve()
				try {
					await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
				} finally {
					await cleanup.promise
				}
				return [[], false]
			})
			let settled = false
			const reason = new Error("cancelled listing")
			const pending = new ListFilesTool().processCall({ paths: ["."] }, h.env)
			const rejection = assert.rejects(pending, (error) => stop === "timeout" ? error instanceof ToolTimeoutError : error === reason)
				.then(() => { settled = true })
			await clock.tickAsync(0)
			await started.promise
			if (stop === "timeout") await clock.tickAsync(30_001)
			else h.controller.abort(reason)
			await clock.tickAsync(0)
			assert.equal(signal.aborted, true)
			assert.equal(settled, false)
			cleanup.resolve()
			await rejection
			const card = await h.taskMessenger.createCard.firstCall.returnValue
			assert.equal(card.getCard().status, stop === "timeout" ? CardStatus.ERROR : CardStatus.CANCELLED)
		})
	}

	it("times out skill discovery without activating a late service result", async () => {
		const clock = sinon.useFakeTimers()
		const h = fixture()
		const query = deferred<[]>()
		sinon.stub(h.env.skills, "getAvailableSkills").returns(query.promise)
		const content = sinon.spy(h.env.skills, "getSkillContent")
		const activation = sinon.spy(h.env.orchestration, "activateSkill")
		const rejection = assert.rejects(new UseSkillTool().processCall({ skill_name: "late" }, h.env), ToolTimeoutError)
		await clock.tickAsync(30_001)
		await rejection
		query.resolve([])
		await clock.tickAsync(0)
		sinon.assert.notCalled(content)
		sinon.assert.notCalled(activation)
	})

	it("cancels rich-file observation without committing a late extraction to the cache", async () => {
		const h = fixture()
		const started = deferred<void>()
		const query = deferred<{ text: string }>()
		sinon.stub(h.env.workspace, "resolvePath").resolves({ absolutePath: "/workspace/late.pdf", displayPath: "late.pdf" })
		sinon.stub(h.env.workspace, "readRichFile").callsFake(() => { started.resolve(); return query.promise })
		const writes = sinon.spy(h.env.context.task, "updateEntries")
		const reason = new Error("cancelled extraction")
		const pending = new ReadFileTool().processCall({ paths: ["late.pdf"] }, h.env)
		const rejection = assert.rejects(pending, (error) => error === reason)
		await started.promise
		h.controller.abort(reason)
		await rejection
		query.resolve({ text: "late result" })
		await new Promise<void>((resolve) => setImmediate(resolve))
		sinon.assert.notCalled(writes)
	})
})
