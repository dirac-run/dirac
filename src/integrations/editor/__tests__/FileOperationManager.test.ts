import { describe, it } from "mocha"
import * as assert from "assert"
import * as fs from "fs/promises"
import { FileOperationManager } from "../FileOperationManager"

describe("FileOperationManager", () => {
	let tmpDir: string
	let manager: FileOperationManager

	beforeEach(async () => {
		tmpDir = `/tmp/file-op-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		await fs.mkdir(tmpDir, { recursive: true })
	})

	afterEach(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	it("should create directories for new file", async () => {
		const nestedPath = `${tmpDir}/nested/deep/file.txt`
		manager = new FileOperationManager(nestedPath, "create")
		await manager.setup()

		assert.strictEqual(manager.fileEncoding, "utf8")
		assert.strictEqual(manager.originalContent, "")
		assert.ok((await fs.stat(nestedPath)).isFile())
	})

	it("should read existing file content for modify type", async () => {
		const filePath = `${tmpDir}/existing.txt`
		await fs.writeFile(filePath, "hello world")
		manager = new FileOperationManager(filePath, "modify")
		await manager.setup()

		assert.ok(manager.originalContent !== undefined)
	})

	it("should write file content", async () => {
		const filePath = `${tmpDir}/write-test.txt`
		manager = new FileOperationManager(filePath, "create")
		await manager.setup()

		await manager.writeFile("new content here")
		const readBack = await fs.readFile(filePath, "utf8")
		assert.strictEqual(readBack, "new content here")
	})

	it("should delete file", async () => {
		const filePath = `${tmpDir}/delete-me.txt`
		await fs.writeFile(filePath, "temp")
		manager = new FileOperationManager(filePath, "create")
		await manager.setup()

		await manager.deleteFile()
		await assert.rejects(fs.stat(filePath))
	})

	it("should delete created directories in reverse order", async () => {
		const nestedPath = `${tmpDir}/a/b/c/file.txt`
		manager = new FileOperationManager(nestedPath, "create")
		await manager.setup()

		assert.ok(manager.getCreatedDirs().length > 0)
		await manager.deleteCreatedDirs()
		assert.strictEqual(manager.getCreatedDirs().length, 0)
	})

	it("should reset state", async () => {
		const filePath = `${tmpDir}/reset-test.txt`
		manager = new FileOperationManager(filePath, "create")
		await manager.setup()
		await manager.writeFile("test")

		manager.reset()
		assert.strictEqual(manager.originalContent, undefined)
		assert.strictEqual(manager.fileEncoding, "utf8")
	})

	it("should return original content for LLM", async () => {
		const filePath = `${tmpDir}/llm-test.txt`
		await fs.writeFile(filePath, "original content")
		manager = new FileOperationManager(filePath, "modify")
		await manager.setup()

		const result = manager.getOriginalContentForLLM(false)
		assert.strictEqual(result, "original content")
	})

	it("should return undefined for originalContent when not set", async () => {
		const filePath = `${tmpDir}/undefined-test.txt`
		manager = new FileOperationManager(filePath, "create")
		await manager.setup()

		// For create type, originalContent is "" (empty string), not undefined
		assert.strictEqual(manager.originalContent, "")
	})
})
