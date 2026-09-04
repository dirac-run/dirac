import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { appendOperationRecords, replayOperationRecords, writeFramedBaseline } from "../operationLog"

describe("operationLog", () => {
	let directory: string
	let filePath: string

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-operation-log-"))
		filePath = path.join(directory, "operations.jsonl")
	})

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("appends one framed batch and replays records in order", async () => {
		const byteCount = await appendOperationRecords(filePath, [
			{ offset: 0, text: "a" },
			{ offset: 1, text: "b" },
		])
		const records: unknown[] = []
		await replayOperationRecords(filePath, (record) => records.push(record))

		assert.deepEqual(records, [
			{ offset: 0, text: "a" },
			{ offset: 1, text: "b" },
		])
		assert.equal(byteCount, Buffer.byteLength(await fs.readFile(filePath, "utf8")))
	})

	it("uses LF framing when JSON payloads contain Unicode line boundaries", async () => {
		const expected = [
			{ offset: 0, text: "line separator: \u2028" },
			{ offset: 1, text: "paragraph separator: \u2029" },
		]
		await appendOperationRecords(filePath, expected)

		const encoded = await fs.readFile(filePath, "utf8")
		assert.equal(encoded.split("\n").length - 1, expected.length)
		assert.equal(encoded.includes("\u2028"), true)
		assert.equal(encoded.includes("\u2029"), true)

		const records: unknown[] = []
		await replayOperationRecords(filePath, (record) => records.push(record))
		assert.deepEqual(records, expected)
	})

	it("discards only an incomplete final frame", async () => {
		await fs.writeFile(filePath, '{"offset":0}\n{"offset":1')
		const records: unknown[] = []
		await replayOperationRecords(filePath, (record) => records.push(record))
		assert.deepEqual(records, [{ offset: 0 }])

		await fs.writeFile(filePath, '{"offset":0}\nnot-json\n')
		await assert.rejects(
			replayOperationRecords(filePath, () => undefined),
			/Invalid operation record/,
		)
	})

	it("distinguishes valid JSON that fails semantic replay", async () => {
		await fs.writeFile(filePath, '{"offset":0}\n')

		await assert.rejects(
			replayOperationRecords(filePath, () => {
				throw new Error("missing replay target")
			}),
			(error: Error) =>
				error.message.includes("Failed to apply operation record") &&
				error.cause instanceof Error &&
				error.cause.message === "missing replay target",
		)
	})

	it("truncates an incomplete tail before a later append", async () => {
		await fs.writeFile(filePath, '{"offset":0,"value":"complete"}\n{"offset":1')

		await appendOperationRecords(filePath, [{ offset: 1, value: "resumed" }])

		const records: unknown[] = []
		await replayOperationRecords(filePath, (record) => records.push(record))
		assert.deepEqual(records, [
			{ offset: 0, value: "complete" },
			{ offset: 1, value: "resumed" },
		])
	})

	it("writes independently framed baselines", async () => {
		await writeFramedBaseline(filePath, [
			{ type: "baseline", offset: 4 },
			{ type: "entry", value: "x" },
		])
		const records: unknown[] = []
		await replayOperationRecords(filePath, (record) => records.push(record))
		assert.deepEqual(records, [
			{ type: "baseline", offset: 4 },
			{ type: "entry", value: "x" },
		])
	})

	it("replays Unicode line boundaries from framed baselines", async () => {
		const expected = [{ type: "entry", value: "before\u2028middle\u2029after" }]
		await writeFramedBaseline(filePath, expected)

		const records: unknown[] = []
		await replayOperationRecords(filePath, (record) => records.push(record))
		assert.deepEqual(records, expected)
	})
})
