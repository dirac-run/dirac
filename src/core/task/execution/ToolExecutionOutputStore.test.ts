import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { ToolExecutionOutcome } from "@shared/toolExecution"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { DiskToolExecutionOutputStore } from "./ToolExecutionOutputStore"

const owner = { rootTaskId: "root", taskId: "task", runId: "run" }
describe("DiskToolExecutionOutputStore", () => {
	let directory: string
	let store: DiskToolExecutionOutputStore
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-execution-output-"))
		store = new DiskToolExecutionOutputStore(directory, owner)
		await store.create("one")
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(directory, { recursive: true, force: true })
	})

	for (const text of ["ASCII chunk", "😀 Unicode chunk"]) {
		it(`rolls back a partial ${text.startsWith("ASCII") ? "ASCII" : "Unicode"} append before retry and reopen`, async () => {
			await store.append("one", "prefix")
			const open = fs.open.bind(fs)
			const writeError = new Error("disk full")
			const stub = sinon.stub(fs, "open").callsFake(async (...args) => {
				const file = await open(...args)
				if (args[1] === "r+") {
					const write = file.write.bind(file)
					const writes = sinon.stub(file, "write")
					// FileHandle.write is overloaded; append uses only its buffer signature.
					writes.onFirstCall().callsFake((async (buffer: Buffer, offset: number, _length: number, position: number) =>
						write(buffer, offset, 1, position)) as typeof file.write)
					writes.onSecondCall().rejects(writeError)
				}
				return file
			})
			await assert.rejects(store.append("one", text), (error) => error === writeError)
			stub.restore()
			const reopened = new DiskToolExecutionOutputStore(directory, owner)
			assert.equal((await reopened.read({ operation: "output", execution_id: "one", limit: 64 })).output, "prefix")
			await reopened.append("one", text)
			await reopened.close("one")
			assert.equal((await reopened.read({ operation: "output", execution_id: "one", limit: 64 })).output, `prefix${text}`)
		})
	}

	it("reports both append and rollback failures instead of claiming recovery", async () => {
		const open = fs.open.bind(fs)
		const writeError = new Error("write failed")
		const rollbackError = new Error("truncate failed")
		sinon.stub(fs, "open").callsFake(async (...args) => {
			const file = await open(...args)
			if (args[1] === "r+") {
				sinon.stub(file, "write").rejects(writeError)
				sinon.stub(file, "truncate").rejects(rollbackError)
			}
			return file
		})
		await assert.rejects(store.append("one", "text"), (error) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors, [writeError, rollbackError])
			return true
		})
	})

	it("preserves append order and reopens retained streams without truncation", async () => {
		await Promise.all([store.append("one", "first"), store.append("one", "second")])
		const reopened = new DiskToolExecutionOutputStore(directory, owner)
		assert.equal((await reopened.read({ operation: "output", execution_id: "one", limit: 64 })).output, "firstsecond")
		await assert.rejects(() => reopened.create("one"), /EEXIST/)
	})

	it("returns bounded Unicode fragments without splitting characters or losing BOMs", async () => {
		const text = "\ufeffA😀€中B😀end"
		await store.append("one", text)
		await store.close("one")
		let cursor: string | undefined
		let restored = ""
		for (let i = 0; i < 30; i++) {
			const page = await store.read({ operation: "output", execution_id: "one", limit: 4, cursor })
			assert.ok(Buffer.byteLength(page.output, "utf8") <= 4)
			assert.equal(page.closed, true)
			assert.equal(page.truncated, false)
			if (!page.output) break
			restored += page.output
			cursor = page.next_cursor
		}
		assert.equal(restored, text)
	})

	it("reuses an end cursor for later output and distinguishes current end from closed", async () => {
		const empty = await store.read({ operation: "output", execution_id: "one", limit: 4 })
		assert.equal(empty.output, "")
		assert.equal(empty.closed, false)
		await store.append("one", "late")
		const late = await store.read({ operation: "output", execution_id: "one", limit: 4, cursor: empty.next_cursor })
		assert.equal(late.output, "late")
		await store.close("one")
		assert.equal(
			(await store.read({ operation: "output", execution_id: "one", limit: 4, cursor: late.next_cursor })).closed,
			true,
		)
		await assert.rejects(() => store.append("one", "no"), /closed/)
	})

	it("pages the entire immutable final outcome, including image content and failure details", async () => {
		const outcome: ToolExecutionOutcome = {
			kind: "settlement_failed",
			error: { code: "POST_HOOK", message: "failed" },
			operationOutcome: {
				kind: "success",
				content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
			},
		}
		const before = await store.read({ operation: "output", execution_id: "one", view: "result", limit: 16 })
		assert.equal(before.closed, false)
		await store.writeResult("one", outcome)
		await store.writeResult("one", outcome)
		await assert.rejects(() => store.writeResult("one", { kind: "success", content: "replacement" }), /replace/)
		let cursor = before.next_cursor
		let json = ""
		for (; ;) {
			const page = await store.read({ operation: "output", execution_id: "one", view: "result", limit: 16, cursor })
			assert.equal(page.closed, true)
			if (!page.output) break
			json += page.output
			cursor = page.next_cursor
		}
		assert.deepEqual(JSON.parse(json), outcome)
	})

	it("inspection is nonconsuming and cursors reject foreign execution/view/owner scopes", async () => {
		await store.append("one", "abcdef")
		const request = { operation: "output" as const, execution_id: "one", limit: 4 }
		const first = await store.read(request)
		assert.deepEqual(await store.read(request), first)
		await store.create("two")
		await assert.rejects(() => store.read({ ...request, execution_id: "two", cursor: first.next_cursor }), /foreign/)
		await assert.rejects(() => store.read({ ...request, view: "result", cursor: first.next_cursor }), /foreign/)
		const other = new DiskToolExecutionOutputStore(directory, { ...owner, runId: "other" })
		await assert.rejects(() => other.read({ ...request, cursor: first.next_cursor }), /foreign/)
	})

	it("rejects invalid budgets, unknown output, malformed and mid-character cursors", async () => {
		for (const limit of [0, 1, 3, 4.5, 65537])
			await assert.rejects(() => store.read({ operation: "output", execution_id: "one", limit }), /limit/)
		await assert.rejects(() => store.append("unknown", "text"), /ENOENT/)
		await assert.rejects(() => store.read({ operation: "output", execution_id: "unknown", limit: 4 }), /ENOENT/)
		await assert.rejects(() => store.read({ operation: "output", execution_id: "one", limit: 4, cursor: "not-json" }))
		await store.append("one", "😀ok")
		const cursor = Buffer.from(JSON.stringify([owner.rootTaskId, owner.taskId, owner.runId, "one", "stream", 1])).toString(
			"base64url",
		)
		await assert.rejects(() => store.read({ operation: "output", execution_id: "one", limit: 4, cursor }), /splits/)
	})

	it("pins request identity and budget before queued reads", async () => {
		await store.append("one", "original")
		const request = { operation: "output" as const, execution_id: "one", limit: 4 }
		const reading = store.read(request)
		request.execution_id = "unknown"
		request.limit = 65537
		const page = await reading
		assert.equal(page.execution_id, "one")
		assert.equal(page.output, "orig")
	})

	it("does not turn output IDs into filesystem paths", async () => {
		await store.create("../outside")
		await store.append("../outside", "safe")
		assert.equal((await store.read({ operation: "output", execution_id: "../outside", limit: 4 })).output, "safe")
		assert.ok((await fs.readdir(directory)).every((file) => /^[a-f0-9]{64}\.(stream|closed|result)$/.test(file)))
	})
})
