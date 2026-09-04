import * as assert from "assert"
import { after, afterEach, before, describe, it } from "mocha"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { pathToFileURL } from "url"
import { Logger } from "@/shared/services/Logger"
import { extractTextFromFile, processFilesIntoText } from "../extract-text"

describe("extract-text", () => {
	describe("extractTextFromFile", () => {
		it("reads text from a local file", async () => {
			const tempFile = path.join(os.tmpdir(), `dirac-extract-test-${Date.now()}.txt`)
			await fs.writeFile(tempFile, "hello world")
			try {
				const content = await extractTextFromFile(tempFile)
				assert.strictEqual(content, "hello world")
			} finally {
				await fs.unlink(tempFile).catch(() => {})
			}
		})
	})

	describe("processFilesIntoText", () => {
		let tempFile: string
		let fileUrl: string

		before(async () => {
			tempFile = path.join(os.tmpdir(), `dirac-extract-test-${Date.now()}.txt`)
			await fs.writeFile(tempFile, "hello world")
			fileUrl = pathToFileURL(tempFile).href
		})

		after(async () => {
			await fs.unlink(tempFile).catch(() => {})
		})

		afterEach(() => {
			sinon.restore()
		})

		it("resolves file:// URIs to a local path", async () => {
			const result = await processFilesIntoText([fileUrl])
			assert.ok(result.includes("hello world"))
			assert.ok(result.includes(tempFile.replace(/\\/g, "/")))
		})

		it("warns and skips space:// URIs", async () => {
			const warnStub = sinon.stub(Logger, "warn")
			const spaceUri = "space://1788434544580-1rccxfssm/Find%20PR-FEEDBACK-STATUS.md"
			const result = await processFilesIntoText([spaceUri])
			assert.ok(result.includes("Space resource unavailable"))
			assert.ok(result.includes(spaceUri))
			assert.ok(warnStub.calledOnce)
		})

		it("warns and skips unsupported URI schemes", async () => {
			const warnStub = sinon.stub(Logger, "warn")
			const result = await processFilesIntoText(["foo://bar/baz.txt"])
			assert.ok(result.includes('Unsupported URI scheme "foo"'))
			assert.ok(warnStub.calledOnce)
		})

		it("logs error for missing local files", async () => {
			const errorStub = sinon.stub(Logger, "error")
			const missing = path.join(os.tmpdir(), `dirac-extract-missing-${Date.now()}.txt`)
			const result = await processFilesIntoText([missing])
			assert.ok(result.includes("Error fetching content"))
			assert.ok(result.includes("File not found"))
			assert.ok(errorStub.calledOnce)
		})
	})
})
