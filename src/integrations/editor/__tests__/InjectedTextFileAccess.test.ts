import * as assert from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { FileEditProvider } from "../FileEditProvider"
import { FileOperationManager } from "../FileOperationManager"
import type { TextFileAccess, TextFileReadResult, TextFileWriteResult } from "../TextFileAccess"

class FakeTextFileAccess implements TextFileAccess {
	readonly reads: string[] = []
	readonly writes: Array<{ path: string; content: string }> = []
	readResult: TextFileReadResult = { content: "original", encoding: "utf16le" }
	confirmedContent?: string
	readError?: Error
	writeError?: Error

	async readText(filePath: string): Promise<TextFileReadResult> {
		this.reads.push(filePath)
		if (this.readError) throw this.readError
		return this.readResult
	}

	async writeText(filePath: string, content: string): Promise<TextFileWriteResult> {
		this.writes.push({ path: filePath, content })
		if (this.writeError) throw this.writeError
		return { content: this.confirmedContent ?? content }
	}
}

describe("injected TextFileAccess editing lifecycle", () => {
	let directory: string
	let saveRequests: string[]

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "injected-text-access-"))
		saveRequests = []
		setVscodeHostProviderMock({
			hostBridgeClient: {
				workspaceClient: {
					getWorkspacePaths: async () => ({ paths: [directory] }),
					saveOpenDocumentIfDirty: async ({ filePath }: { filePath: string }) => {
						saveRequests.push(filePath)
						return {}
					},
					getDiagnostics: async () => ({ fileDiagnostics: [] }),
				},
			} as any,
		})
	})

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("reads through the configured transport without saving open documents", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "read-only.txt")
		const provider = new FileEditProvider(access)

		assert.strictEqual(await provider.readText(filePath), "original")
		assert.deepStrictEqual(access.reads, [filePath])
		assert.deepStrictEqual(access.writes, [])
		assert.deepStrictEqual(saveRequests, [])
	})

	it("gets modified-file content and encoding from the injected access", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "existing.txt")
		const manager = new FileOperationManager(filePath, "modify", access)

		await manager.setup()
		assert.strictEqual(manager.originalContent, "original")
		assert.strictEqual(manager.fileEncoding, "utf16le")
		assert.deepStrictEqual(access.reads, [filePath])
	})

	it("materializes, writes, and reads through the injected access", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "nested", "new.txt")
		const manager = new FileOperationManager(filePath, "create", access)

		await manager.setup()
		assert.deepStrictEqual(access.writes[0], { path: filePath, content: "" })
		await manager.writeFile("saved")
		assert.deepStrictEqual(access.writes[1], { path: filePath, content: "saved" })
		assert.strictEqual(await manager.readFile(), "original")
		assert.deepStrictEqual(access.reads, [filePath])
		assert.ok(manager.getCreatedDirs().length > 0)
	})

	it("propagates injected read and write failures", async () => {
		const readAccess = new FakeTextFileAccess()
		readAccess.readError = new Error("read denied")
		await assert.rejects(
			new FileOperationManager(path.join(directory, "read.txt"), "modify", readAccess).setup(),
			/read denied/,
		)

		const writeAccess = new FakeTextFileAccess()
		writeAccess.writeError = new Error("write denied")
		await assert.rejects(
			new FileOperationManager(path.join(directory, "write.txt"), "create", writeAccess).setup(),
			/write denied/,
		)
	})

	it("does not materialize delete targets and rejects a missing local deletion", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "missing-delete.txt")
		const manager = new FileOperationManager(filePath, "delete", access)

		await manager.setup()
		assert.deepStrictEqual(access.writes, [])
		assert.deepStrictEqual(manager.getCreatedDirs(), [])
		await assert.rejects(manager.deleteFile(), /ENOENT/)
	})

	it("reads existing content before background modification without truncating first", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "background-modify.txt")
		const provider = new FileEditProvider(access, false, false)

		await provider.applyAndSaveSilently(filePath, "updated", "modify")

		assert.deepStrictEqual(access.reads, [filePath])
		assert.deepStrictEqual(access.writes, [{ path: filePath, content: "updated" }])
	})

	it("retains configured dirty-document saves when initializing an approved write", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "approved-modify.txt")
		const provider = new FileEditProvider(access, true, false)

		await provider.applyAndSaveSilently(filePath, "approved change", "modify")

		assert.deepStrictEqual(saveRequests, [filePath])
		assert.deepStrictEqual(access.writes, [{ path: filePath, content: "approved change" }])
	})

	it("materializes an empty file only for explicit background creation", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "background-create.txt")
		const provider = new FileEditProvider(access, false, false)

		await provider.applyAndSaveSilently(filePath, "created", "create")

		assert.deepStrictEqual(access.reads, [])
		assert.deepStrictEqual(access.writes, [
			{ path: filePath, content: "" },
			{ path: filePath, content: "created" },
		])
	})

	it("saves an empty document", async () => {
		const access = new FakeTextFileAccess()
		access.readResult = { content: "", encoding: "utf8" }
		const filePath = path.join(directory, "empty-save.txt")
		const provider = new FileEditProvider(access, false)
		provider.editType = "modify"

		await provider.open(filePath)
		await provider.update("", true)
		const result = await provider.saveChanges({ skipDiagnostics: true })

		assert.deepStrictEqual(access.writes.at(-1), { path: filePath, content: "" })
		assert.strictEqual(await provider.getContent(), "")
		assert.strictEqual(result.finalContent, "")
	})

	it("updates current content from the confirmed write result", async () => {
		const access = new FakeTextFileAccess()
		access.confirmedContent = "formatted\n"
		const filePath = path.join(directory, "formatted.txt")
		const provider = new FileEditProvider(access, false, false)
		provider.editType = "modify"

		await provider.open(filePath)
		await provider.update("submitted", true)
		await provider.saveChanges({ skipDiagnostics: true })

		assert.deepStrictEqual(access.writes.at(-1), { path: filePath, content: "submitted" })
		assert.strictEqual(await provider.getContent(), "formatted\n")
		assert.strictEqual(await provider.format(filePath), "formatted\n")
	})

	it("makes save and revert failures visible", async () => {
		expectLoggerErrors()
		const saveAccess = new FakeTextFileAccess()
		saveAccess.writeError = new Error("save denied")
		const saveProvider = new FileEditProvider(saveAccess, false)
		saveProvider.editType = "modify"
		await saveProvider.open(path.join(directory, "save-failure.txt"))
		await saveProvider.update("changed", true)
		await assert.rejects(saveProvider.saveChanges({ skipDiagnostics: true }), /save denied/)

		const revertAccess = new FakeTextFileAccess()
		const revertProvider = new FileEditProvider(revertAccess, false)
		revertProvider.editType = "modify"
		await revertProvider.open(path.join(directory, "revert-failure.txt"))
		await revertProvider.update("changed", true)
		revertAccess.writeError = new Error("revert denied")
		await assert.rejects(revertProvider.revertChanges(), /revert denied/)
	})

	it("revert writes original content and reset clears in-memory state", async () => {
		const access = new FakeTextFileAccess()
		const filePath = path.join(directory, "revert.txt")
		const provider = new FileEditProvider(access, false)
		provider.editType = "modify"

		await provider.open(filePath)
		await provider.update("changed", true)
		await provider.revertChanges()

		assert.deepStrictEqual(access.writes.at(-1), { path: filePath, content: "original" })
		assert.strictEqual(await provider.getContent(), undefined)
	})

	it("clears prior document state when a later open fails", async () => {
		const access = new FakeTextFileAccess()
		const firstPath = path.join(directory, "first.txt")
		const secondPath = path.join(directory, "second.txt")
		const provider = new FileEditProvider(access, false, false)
		await provider.applyAndSaveSilently(firstPath, "first updated", "modify")
		access.readError = new Error("second read denied")

		await assert.rejects(provider.open(secondPath, { editType: "modify" }), /second read denied/)
		await assert.rejects(provider.saveChanges({ skipDiagnostics: true }), /Failed to save changes/)

		assert.deepStrictEqual(access.writes, [{ path: firstPath, content: "first updated" }])
		assert.strictEqual(await provider.getContent(), undefined)
	})

})
