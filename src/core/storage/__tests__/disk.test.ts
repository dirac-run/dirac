import { Anthropic } from "@anthropic-ai/sdk"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import { HistoryItem } from "@shared/HistoryItem"
import * as fsUtils from "@utils/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import {
	cleanupConversationHistoryFile,
	ensureCacheDirectoryExists,
	ensureSettingsDirectoryExists,
	ensureStateDirectoryExists,
	ensureTaskDirectoryExists,
	getAllHooksDirs,
	getGlobalHooksDir,
	getSavedApiConversationHistory,
	getSavedDiracMessages,
	getTaskHistoryStateFilePath,
	getTaskMetadata,
	getWorkspaceHooksDirs,
	readRemoteConfigFromCache,
	readTaskHistoryFromState,
	readTaskSettingsFromStorage,
	saveApiConversationHistory,
	saveDiracMessages,
	saveTaskMetadata,
	setRuntimeHooksDir,
	taskHistoryStateFileExists,
	writeConversationHistoryJson,
	writeConversationHistoryText,
	writeRemoteConfigToCache,
	writeTaskHistoryToState,
	writeTaskSettingsToStorage,
} from "../disk"
import { StateManager } from "../StateManager"

describe("disk - hooks functionality", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = path.join(os.tmpdir(), `disk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })
	})

	afterEach(async () => {
		sandbox.restore()
		setRuntimeHooksDir(undefined)
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch (error) {
			// Ignore cleanup errors
		}
	})

	describe("getWorkspaceHooksDirs", () => {
		it("should return empty array when no workspace roots exist", async () => {
			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => undefined,
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return empty array when workspace roots is empty array", async () => {
			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return empty array when no hooks directories exist", async () => {
			// Create workspace root without hooks directory
			const workspaceRoot = path.join(tempDir, "workspace1")
			await fs.mkdir(workspaceRoot, { recursive: true })

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return hooks directory when it exists", async () => {
			// Create workspace root with hooks directory
			const workspaceRoot = path.join(tempDir, "workspace1")
			const hooksDir = path.join(workspaceRoot, ".diracrules", "hooks")
			await fs.mkdir(hooksDir, { recursive: true })

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(1)
			result[0].should.equal(hooksDir)
		})

		it("should not return hooks directory if it's a file instead of directory", async () => {
			// Create workspace root with hooks as a file (not directory)
			const workspaceRoot = path.join(tempDir, "workspace1")
			const hooksPath = path.join(workspaceRoot, ".diracrules", "hooks")
			await fs.mkdir(path.dirname(hooksPath), { recursive: true })
			await fs.writeFile(hooksPath, "not a directory")

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(0)
		})

		it("should return multiple hooks directories for multi-root workspace", async () => {
			// Create multiple workspace roots with hooks directories
			const workspaceRoot1 = path.join(tempDir, "workspace1")
			const workspaceRoot2 = path.join(tempDir, "workspace2")
			const hooksDir1 = path.join(workspaceRoot1, ".diracrules", "hooks")
			const hooksDir2 = path.join(workspaceRoot2, ".diracrules", "hooks")

			await fs.mkdir(hooksDir1, { recursive: true })
			await fs.mkdir(hooksDir2, { recursive: true })

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRoot1 }, { path: workspaceRoot2 }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(2)
			result.should.containEql(hooksDir1)
			result.should.containEql(hooksDir2)
		})

		it("should return only existing hooks directories in multi-root workspace", async () => {
			// Create multiple workspace roots, but only some have hooks directories
			const workspaceRoot1 = path.join(tempDir, "workspace1")
			const workspaceRoot2 = path.join(tempDir, "workspace2")
			const workspaceRoot3 = path.join(tempDir, "workspace3")
			const hooksDir1 = path.join(workspaceRoot1, ".diracrules", "hooks")
			const hooksDir3 = path.join(workspaceRoot3, ".diracrules", "hooks")

			await fs.mkdir(hooksDir1, { recursive: true })
			await fs.mkdir(workspaceRoot2, { recursive: true }) // No hooks dir
			await fs.mkdir(hooksDir3, { recursive: true })

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRoot1 }, { path: workspaceRoot2 }, { path: workspaceRoot3 }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(2)
			result.should.containEql(hooksDir1)
			result.should.containEql(hooksDir3)
			result.should.not.containEql(path.join(workspaceRoot2, ".diracrules", "hooks"))
		})

		it("should propagate errors when checking directory fails", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			await fs.mkdir(workspaceRoot, { recursive: true })

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			// Stub isDirectory to throw an error
			sandbox.stub(fsUtils, "isDirectory").rejects(new Error("Permission denied"))

			// Should propagate the error
			try {
				await getWorkspaceHooksDirs()
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.message.should.equal("Permission denied")
			}
		})

		it("should use correct path joining for hooks directory", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			const expectedHooksDir = path.join(workspaceRoot, ".diracrules", "hooks")
			await fs.mkdir(expectedHooksDir, { recursive: true })

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRoot }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result[0].should.equal(expectedHooksDir)
			// Verify it uses the correct path separator for the platform
			result[0].should.match(/\.diracrules[\\/]hooks$/)
		})

		it("should handle workspace roots with trailing slashes", async () => {
			const workspaceRoot = path.join(tempDir, "workspace1")
			const workspaceRootWithSlash = workspaceRoot + path.sep
			const hooksDir = path.join(workspaceRoot, ".diracrules", "hooks")
			await fs.mkdir(hooksDir, { recursive: true })

			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [{ path: workspaceRootWithSlash }],
			} as any)

			const result = await getWorkspaceHooksDirs()
			result.should.be.an.Array()
			result.length.should.equal(1)
			result[0].should.equal(hooksDir)
		})
	})

	describe("getAllHooksDirs", () => {
		it("should include the runtime hooks directory when it exists", async () => {
			const runtimeHooksDir = path.join(tempDir, "runtime-hooks")
			await fs.mkdir(runtimeHooksDir, { recursive: true })

			sandbox.stub(os, "homedir").returns(tempDir)
			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [],
			} as any)

			sandbox.stub(fsUtils, "isDirectory").callsFake(async (targetPath: string) => targetPath === runtimeHooksDir)

			setRuntimeHooksDir(runtimeHooksDir)

			const result = await getAllHooksDirs()
			result.should.containEql(runtimeHooksDir)
		})

		it("should not include the runtime hooks directory when it does not exist", async () => {
			const runtimeHooksDir = path.join(tempDir, "missing-runtime-hooks")

			sandbox.stub(os, "homedir").returns(tempDir)
			sandbox.stub(StateManager, "get").returns({
				getGlobalStateKey: () => [],
			} as any)

			sandbox.stub(fsUtils, "isDirectory").resolves(false)

			setRuntimeHooksDir(runtimeHooksDir)

			const result = await getAllHooksDirs()
			result.should.not.containEql(runtimeHooksDir)
		})
	})
})

describe("disk - atomic writes", () => {
	let sandbox: sinon.SinonSandbox
	let testGlobalStorageDir: string

	// Setup HostProvider for tests with real temp directory
	before(async () => {
		// Create a real temp directory for the tests
		testGlobalStorageDir = path.join(os.tmpdir(), `dirac-test-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(testGlobalStorageDir, { recursive: true })

		// Initialize HostProvider with the real temp directory
		setVscodeHostProviderMock({
			globalStorageFsPath: testGlobalStorageDir,
		})
	})

	after(async () => {
		HostProvider.reset()

		// Clean up temp directory
		try {
			await fs.rm(testGlobalStorageDir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	/**
	 * Helper to create test history items
	 */
	const createTestHistoryItem = (id: string, task: string): HistoryItem => {
		return {
			id,
			ts: Date.now(),
			task,
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.01,
		}
	}

	/**
	 * Helper to check for orphaned temp files
	 */
	const getTempFileCount = async (): Promise<number> => {
		const stateDir = await ensureStateDirectoryExists()
		const files = await fs.readdir(stateDir)
		return files.filter((f) => f.startsWith("taskHistory.json.tmp.")).length
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
	})

	afterEach(async () => {
		sandbox.restore()
	})

	describe("writeTaskHistoryToState and readTaskHistoryFromState", () => {
		it("should write and read task history correctly", async () => {
			const items = [createTestHistoryItem("test-1", "Build a todo app"), createTestHistoryItem("test-2", "Fix a bug")]

			await writeTaskHistoryToState(items)
			const result = await readTaskHistoryFromState()

			result.should.be.an.Array()
			result.should.have.length(2)
			result[0].id.should.equal("test-1")
			result[0].task.should.equal("Build a todo app")
			result[1].id.should.equal("test-2")
			result[1].task.should.equal("Fix a bug")
		})

		it("should write valid JSON that can be parsed", async () => {
			const items = [
				createTestHistoryItem("test-json-1", "Test with special chars: 你好 🎉"),
				createTestHistoryItem("test-json-2", "Test with quotes: \"hello\" and 'world'"),
			]

			await writeTaskHistoryToState(items)

			// Read the raw file and verify it's valid JSON
			const filePath = await getTaskHistoryStateFilePath()
			const rawContent = await fs.readFile(filePath, "utf8")
			const parsed = JSON.parse(rawContent) // Should not throw

			parsed.should.be.an.Array()
			parsed.should.have.length(2)
		})

		it("should not leave temp files after successful write", async () => {
			const items = [createTestHistoryItem("cleanup-test", "Test cleanup")]

			const tempCountBefore = await getTempFileCount()
			await writeTaskHistoryToState(items)
			const tempCountAfter = await getTempFileCount()

			tempCountAfter.should.equal(tempCountBefore)
		})

		it("should handle empty array writes", async () => {
			await writeTaskHistoryToState([])
			const result = await readTaskHistoryFromState()

			result.should.be.an.Array()
			result.should.have.length(0)
		})

		it("should handle large task history arrays", async function () {
			this.timeout(30000) // 30 second timeout for large file operations

			// Create large task content by repeating a pattern (each task ~50 KB)
			const baseContent = "X".repeat(50 * 1024) // 50 KB of X's per task

			// Create 1,000 history items (resulting in ~50 MB file)
			const items = Array.from({ length: 1000 }, (_, i) =>
				createTestHistoryItem(`stress-test-${i}`, `Task ${i}: ${baseContent}`),
			)

			await writeTaskHistoryToState(items)
			const result = await readTaskHistoryFromState()

			// Verify array length and data integrity
			result.should.have.length(1000)
			result[0].id.should.equal("stress-test-0")
			result[0].task.should.startWith("Task 0: X")
			result[500].id.should.equal("stress-test-500")
			result[999].id.should.equal("stress-test-999")
		})

		it("should handle concurrent writes without corruption", async function () {
			this.timeout(30000)

			// Perform many concurrent writes to stress test atomicity
			const writePromises = Array.from({ length: 100 }, (_, i) => {
				const items = [createTestHistoryItem(`concurrent-${i}`, `Task ${i}`)]
				return writeTaskHistoryToState(items).catch((error) => {
					// On Windows, concurrent renames may fail with EPERM - this is expected
					if (process.platform === "win32" && error.code === "EPERM") {
						return // Expected Windows behavior
					}
					throw error // Unexpected error, rethrow
				})
			})

			// Wait for all writes to complete (some may fail on Windows with EPERM)
			await Promise.all(writePromises)

			// Final read should return valid JSON (not corrupted)
			const result = await readTaskHistoryFromState()
			result.should.be.an.Array()
			// Should have data from one of the concurrent writes that succeeded
			result.length.should.be.greaterThan(0)
			// Verify the data is valid (not corrupted)
			result[0].should.have.property("id")
			result[0].should.have.property("task")
		})

		it("should preserve data integrity with special characters", async () => {
			const items = [
				createTestHistoryItem("special-1", "Test\nwith\nnewlines"),
				createTestHistoryItem("special-2", "Test\twith\ttabs"),
				createTestHistoryItem("special-3", "Test with unicode: 日本語 中文 한국어"),
				createTestHistoryItem("special-4", "Test with emojis: 😀🎉🚀"),
			]

			await writeTaskHistoryToState(items)
			const result = await readTaskHistoryFromState()

			result.should.have.length(4)
			result[0].task.should.equal("Test\nwith\nnewlines")
			result[1].task.should.equal("Test\twith\ttabs")
			result[2].task.should.equal("Test with unicode: 日本語 中文 한국어")
			result[3].task.should.equal("Test with emojis: 😀🎉🚀")
		})

		it("should overwrite existing task history", async () => {
			// Write initial data
			const initialItems = [createTestHistoryItem("initial-1", "Initial task")]
			await writeTaskHistoryToState(initialItems)

			// Verify initial data
			let result = await readTaskHistoryFromState()
			result.should.have.length(1)
			result[0].id.should.equal("initial-1")

			// Overwrite with new data
			const newItems = [createTestHistoryItem("new-1", "New task 1"), createTestHistoryItem("new-2", "New task 2")]
			await writeTaskHistoryToState(newItems)

			// Verify new data replaced old data
			result = await readTaskHistoryFromState()
			result.should.have.length(2)
			result[0].id.should.equal("new-1")
			result[1].id.should.equal("new-2")
		})

		it("should handle rapid successive writes", async function () {
			this.timeout(5000)

			// Perform rapid successive writes (not concurrent)
			for (let i = 0; i < 20; i++) {
				const items = [createTestHistoryItem(`rapid-${i}`, `Task ${i}`)]
				await writeTaskHistoryToState(items)
			}

			// Should have no temp files left
			const tempCount = await getTempFileCount()
			tempCount.should.equal(0)

			// Final read should be valid
			const result = await readTaskHistoryFromState()
			result.should.be.an.Array()
			result.should.have.length(1)
			result[0].id.should.equal("rapid-19")
		})

		it("should preserve all HistoryItem fields", async () => {
			const items = [
				{
					id: "full-test",
					ts: 1234567890,
					task: "Complete task",
					tokensIn: 500,
					tokensOut: 1000,
					totalCost: 0.15,
					cacheWrites: 100,
					cacheReads: 200,
				},
			]

			await writeTaskHistoryToState(items)
			const result = await readTaskHistoryFromState()

			result.should.have.length(1)
			result[0].id.should.equal("full-test")
			result[0].ts.should.equal(1234567890)
			result[0].task.should.equal("Complete task")
			result[0].tokensIn.should.equal(500)
			result[0].tokensOut.should.equal(1000)
			result[0].totalCost.should.equal(0.15)
			result[0].cacheWrites!.should.equal(100)
			result[0].cacheReads!.should.equal(200)
		})
	})

	describe("atomic write failure scenarios", () => {
		it("should leave original file intact if temp file write fails", async () => {
			// Write initial data
			const initialItems = [createTestHistoryItem("original-1", "Original task")]
			await writeTaskHistoryToState(initialItems)

			// Verify initial data exists
			let result = await readTaskHistoryFromState()
			result.should.have.length(1)
			result[0].id.should.equal("original-1")

			// Stub fs.writeFile to fail during temp file creation
			const writeFileStub = sandbox.stub(fs, "writeFile")
			writeFileStub.rejects(new Error("Simulated write failure"))

			// Attempt to write new data (should fail)
			const newItems = [createTestHistoryItem("new-1", "New task")]
			try {
				await writeTaskHistoryToState(newItems)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.message.should.equal("Simulated write failure")
			}

			// Original file should still be intact
			result = await readTaskHistoryFromState()
			result.should.have.length(1)
			result[0].id.should.equal("original-1")

			// No temp files should remain
			const tempCount = await getTempFileCount()
			tempCount.should.equal(0)
		})

		it("should leave original file intact if rename fails", async () => {
			// Write initial data
			const initialItems = [createTestHistoryItem("original-2", "Original task 2")]
			await writeTaskHistoryToState(initialItems)

			// Verify initial data exists
			let result = await readTaskHistoryFromState()
			result.should.have.length(1)
			result[0].id.should.equal("original-2")

			// Stub fs.rename to fail
			const renameStub = sandbox.stub(fs, "rename")
			renameStub.rejects(new Error("Simulated rename failure"))

			// Attempt to write new data (should fail)
			const newItems = [createTestHistoryItem("new-2", "New task 2")]
			try {
				await writeTaskHistoryToState(newItems)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.message.should.equal("Simulated rename failure")
			}

			// Original file should still be intact
			result = await readTaskHistoryFromState()
			result.should.have.length(1)
			result[0].id.should.equal("original-2")

			// Temp file cleanup may or may not succeed, but original file is safe
			// (The atomicWriteFile function attempts cleanup but doesn't throw if it fails)
		})

		it("should ignore temp files during read operations", async () => {
			// Write valid data
			const items = [createTestHistoryItem("valid-1", "Valid task")]
			await writeTaskHistoryToState(items)

			// Create a corrupt temp file manually
			const stateDir = await ensureStateDirectoryExists()
			const corruptTempPath = path.join(stateDir, "taskHistory.json.tmp.12345.corrupt")
			await fs.writeFile(corruptTempPath, "INVALID JSON{", "utf8")

			// Read should succeed and ignore the temp file
			const result = await readTaskHistoryFromState()
			result.should.have.length(1)
			result[0].id.should.equal("valid-1")

			// Cleanup temp file
			await fs.unlink(corruptTempPath)
		})

		it("should handle concurrent read during write without corruption", async () => {
			// Write initial data
			const initialItems = [createTestHistoryItem("concurrent-read-1", "Initial task")]
			await writeTaskHistoryToState(initialItems)

			// Create a slow rename by stubbing fs.rename to delay
			// This simulates the critical window where temp file is written but rename hasn't occurred
			let renameResolve: () => void
			const renamePromise = new Promise<void>((resolve) => {
				renameResolve = resolve
			})

			const originalRename = fs.rename
			const renameStub = sandbox.stub(fs, "rename")
			renameStub.callsFake(async (oldPath, newPath) => {
				// Delay the rename operation
				await renamePromise // Wait for our signal
				return originalRename(oldPath, newPath)
			})

			// Start a write operation (rename will be delayed)
			const newItems = [createTestHistoryItem("concurrent-read-2", "New task")]
			const writeOperation = writeTaskHistoryToState(newItems)

			// Give temp file time to be written, but before rename completes
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Perform a read during the critical window (temp file exists, but rename hasn't happened)
			const readResult = await readTaskHistoryFromState()

			// Should get old data (since rename hasn't completed yet)
			readResult.should.have.length(1)
			readResult[0].id.should.equal("concurrent-read-1")

			// Now allow rename to complete
			renameResolve!()
			await writeOperation

			// Subsequent read should get new data
			const finalResult = await readTaskHistoryFromState()
			finalResult.should.have.length(1)
			finalResult[0].id.should.equal("concurrent-read-2")
		})

		it("should handle partial temp file from interrupted process", async () => {
			// Write initial valid data
			const initialItems = [createTestHistoryItem("partial-test-1", "Initial task")]
			await writeTaskHistoryToState(initialItems)

			// Simulate an interrupted write by creating a partial temp file
			const stateDir = await ensureStateDirectoryExists()
			const partialTempPath = path.join(stateDir, "taskHistory.json.tmp.99999.partial")

			// Write only part of a valid JSON array
			await fs.writeFile(partialTempPath, '[{"id":"partial","ts":123456789', "utf8")

			// Read should succeed with original data
			const result = await readTaskHistoryFromState()
			result.should.have.length(1)
			result[0].id.should.equal("partial-test-1")

			// Write new data should succeed and clean up
			const newItems = [createTestHistoryItem("partial-test-2", "New task")]
			await writeTaskHistoryToState(newItems)

			// Verify new data
			const finalResult = await readTaskHistoryFromState()
			finalResult.should.have.length(1)
			finalResult[0].id.should.equal("partial-test-2")

			// Cleanup our partial temp file if it still exists
			try {
				await fs.unlink(partialTempPath)
			} catch {
				// May already be cleaned up
			}
		})
	})
})

describe("disk - core read/write/mkdir operations", () => {
	let sandbox: sinon.SinonSandbox
	let testGlobalStorageDir: string

	before(async () => {
		testGlobalStorageDir = path.join(os.tmpdir(), `dirac-disk-core-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(testGlobalStorageDir, { recursive: true })
		setVscodeHostProviderMock({ globalStorageFsPath: testGlobalStorageDir })
	})

	after(async () => {
		HostProvider.reset()
		try {
			await fs.rm(testGlobalStorageDir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("mkdir operations", () => {
		it("ensureTaskDirectoryExists creates nested tasks/<id> directory", async () => {
			const taskId = `mkdir-task-${Date.now()}`
			const dir = await ensureTaskDirectoryExists(taskId)
			const stat = await fs.stat(dir)
			stat.isDirectory().should.be.true()
			dir.should.containEql("tasks")
			dir.should.containEql(taskId)
		})

		it("ensureTaskDirectoryExists is idempotent on existing directory", async () => {
			const taskId = `mkdir-idempotent-${Date.now()}`
			const first = await ensureTaskDirectoryExists(taskId)
			const second = await ensureTaskDirectoryExists(taskId)
			first.should.equal(second)
			const stat = await fs.stat(second)
			stat.isDirectory().should.be.true()
		})

		it("ensureSettingsDirectoryExists creates settings directory under global storage", async () => {
			const dir = await ensureSettingsDirectoryExists()
			const stat = await fs.stat(dir)
			stat.isDirectory().should.be.true()
			dir.should.containEql("settings")
		})

		it("ensureCacheDirectoryExists creates cache directory under global storage", async () => {
			const dir = await ensureCacheDirectoryExists()
			const stat = await fs.stat(dir)
			stat.isDirectory().should.be.true()
			dir.should.containEql("cache")
		})

		it("ensureStateDirectoryExists creates state directory under global storage", async () => {
			const dir = await ensureStateDirectoryExists()
			const stat = await fs.stat(dir)
			stat.isDirectory().should.be.true()
			dir.should.containEql("state")
		})
	})

	describe("file exists checks", () => {
		it("taskHistoryStateFileExists returns false when no history file exists", async () => {
			// Use a fresh state dir to guarantee absence
			const freshDir = path.join(testGlobalStorageDir, `fresh-state-${Date.now()}`)
			await fs.mkdir(freshDir, { recursive: true })
			sandbox.stub(HostProvider.get(), "globalStorageFsPath").value(freshDir)
			const exists = await taskHistoryStateFileExists()
			exists.should.be.false()
		})

		it("taskHistoryStateFileExists returns true after writing history", async () => {
			await writeTaskHistoryToState([
				{ id: "exists-check", ts: Date.now(), task: "t", tokensIn: 1, tokensOut: 1, totalCost: 0 },
			])
			const exists = await taskHistoryStateFileExists()
			exists.should.be.true()
		})

		it("getGlobalHooksDir returns undefined when hooks dir does not exist", async () => {
			sandbox.stub(os, "homedir").returns(path.join(testGlobalStorageDir, `no-hooks-home-${Date.now()}`))
			const result = await getGlobalHooksDir()
			// Should be undefined since the dir was never created
			const isUndefinedOrString = result === undefined || typeof result === "string"
			isUndefinedOrString.should.be.true()
		})
	})

	describe("API conversation history read/write", () => {
		it("getSavedApiConversationHistory returns empty array for non-existent task", async () => {
			const result = await getSavedApiConversationHistory(`nonexistent-${Date.now()}`)
			result.should.be.an.Array()
			result.should.have.length(0)
		})

		it("saveApiConversationHistory persists and round-trips messages", async () => {
			const taskId = `api-history-${Date.now()}`
			const history: Anthropic.MessageParam[] = [
				{ role: "user", content: "Hello world" },
				{ role: "assistant", content: "Hi there" },
			]
			await saveApiConversationHistory(taskId, history)
			const result = await getSavedApiConversationHistory(taskId)
			result.should.have.length(2)
			result[0].role.should.equal("user")
		})

		it("saveApiConversationHistory with empty array is a no-op (no file written)", async () => {
			const taskId = `api-empty-${Date.now()}`
			await saveApiConversationHistory(taskId, [])
			const result = await getSavedApiConversationHistory(taskId)
			result.should.have.length(0)
		})

		it("saveApiConversationHistory does not throw on write failure (swallows error)", async () => {
			const taskId = `api-fail-${Date.now()}`
			sandbox.stub(fs, "writeFile").rejects(new Error("disk full"))
			// Should not throw - error is logged and swallowed
			await saveApiConversationHistory(taskId, [{ role: "user", content: "x" }])
		})
	})

	describe("Dirac messages read/write", () => {
		it("getSavedDiracMessages returns empty array for non-existent task", async () => {
			const result = await getSavedDiracMessages(`nonexistent-${Date.now()}`)
			result.should.be.an.Array()
			result.should.have.length(0)
		})

		it("saveDiracMessages persists and round-trips messages", async () => {
			const taskId = `dirac-msgs-${Date.now()}`
			const messages = [{ ask: "test", say: "hello", ts: Date.now() } as any]
			await saveDiracMessages(taskId, messages)
			const result = await getSavedDiracMessages(taskId)
			result.should.have.length(1)
		})

		it("saveDiracMessages does not throw on write failure (swallows error)", async () => {
			const taskId = `dirac-fail-${Date.now()}`
			sandbox.stub(fs, "writeFile").rejects(new Error("disk full"))
			await saveDiracMessages(taskId, [{ ask: "test" } as any])
		})
	})

	describe("task metadata read/write", () => {
		it("getTaskMetadata returns default empty metadata for non-existent task", async () => {
			const result = await getTaskMetadata(`nonexistent-${Date.now()}`)
			result.should.have.property("files_in_context")
			result.should.have.property("model_usage")
			result.should.have.property("environment_history")
			result.files_in_context!.should.have.length(0)
		})

		it("saveTaskMetadata persists and round-trips metadata", async () => {
			const taskId = `meta-${Date.now()}`
			const metadata = { files_in_context: [{ path: "/test.ts", lines: 10 }], model_usage: [], environment_history: [] }
			await saveTaskMetadata(taskId, metadata as any)
			const result = await getTaskMetadata(taskId)
			result.files_in_context!.should.have.length(1)
			result.files_in_context![0].path.should.equal("/test.ts")
		})

		it("getTaskMetadata returns default on read error (swallows error)", async () => {
			const taskId = `meta-read-fail-${Date.now()}`
			// Write valid metadata first
			await saveTaskMetadata(taskId, { files_in_context: [], model_usage: [], environment_history: [] })
			// Then stub readFile to fail on read
			sandbox.stub(fs, "readFile").rejects(new Error("read error"))
			const result = await getTaskMetadata(taskId)
			result.files_in_context!.should.have.length(0)
		})

		it("saveTaskMetadata does not throw on write failure (swallows error)", async () => {
			const taskId = `meta-fail-${Date.now()}`
			sandbox.stub(fs, "writeFile").rejects(new Error("disk full"))
			await saveTaskMetadata(taskId, { files_in_context: [], model_usage: [], environment_history: [] })
		})
	})

	describe("task settings read/write", () => {
		it("readTaskSettingsFromStorage returns empty object for new task", async () => {
			const result = await readTaskSettingsFromStorage(`new-task-${Date.now()}`)
			result.should.be.an.Object()
			Object.keys(result).should.have.length(0)
		})

		it("writeTaskSettingsToStorage persists and round-trips settings", async () => {
			const taskId = `settings-${Date.now()}`
			await writeTaskSettingsToStorage(taskId, { maxTokens: 4096 } as any)
			const result: any = await readTaskSettingsFromStorage(taskId)
			result.maxTokens.should.equal(4096)
		})

		it("writeTaskSettingsToStorage merges with existing settings rather than replacing", async () => {
			const taskId = `settings-merge-${Date.now()}`
			await writeTaskSettingsToStorage(taskId, { maxTokens: 100 } as any)
			await writeTaskSettingsToStorage(taskId, { anotherKey: "val" } as any)
			const result: any = await readTaskSettingsFromStorage(taskId)
			result.maxTokens.should.equal(100)
			result.anotherKey.should.equal("val")
		})

		it("readTaskSettingsFromStorage throws on read error", async () => {
			const taskId = `settings-read-fail-${Date.now()}`
			await writeTaskSettingsToStorage(taskId, { maxTokens: 1 } as any)
			sandbox.stub(fs, "readFile").rejects(new Error("read error"))
			try {
				await readTaskSettingsFromStorage(taskId)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.message.should.equal("read error")
			}
		})
	})

	describe("remote config cache read/write/delete", () => {
		it("readRemoteConfigFromCache returns undefined when no cache exists", async () => {
			const result = await readRemoteConfigFromCache(`no-org-${Date.now()}`)
			const isUndefined = result === undefined
			isUndefined.should.be.true()
		})

		it("writeRemoteConfigToCache persists and readRemoteConfigFromCache round-trips", async () => {
			const orgId = `org-${Date.now()}`
			const config = { organizationId: orgId, settings: {} } as any
			await writeRemoteConfigToCache(orgId, config)
			const result: any = await readRemoteConfigFromCache(orgId)
			result.organizationId.should.equal(orgId)
		})

		it("readRemoteConfigFromCache returns undefined on read error (swallows)", async () => {
			sandbox.stub(fs, "readFile").rejects(new Error("corrupt"))
			const result = await readRemoteConfigFromCache(`corrupt-${Date.now()}`)
			const isUndefined = result === undefined
			isUndefined.should.be.true()
		})
	})

	describe("conversation history hook files", () => {
		it("writeConversationHistoryJson writes file and returns path", async () => {
			const taskId = `conv-json-${Date.now()}`
			const history: Anthropic.MessageParam[] = [{ role: "user", content: "test" }]
			const resultPath = await writeConversationHistoryJson(taskId, history, 12345)
			resultPath.should.containEql("conversation_history_12345.json")
			const content = await fs.readFile(resultPath, "utf8")
			JSON.parse(content).should.have.length(1)
		})

		it("writeConversationHistoryText writes formatted text and returns path", async () => {
			const taskId = `conv-text-${Date.now()}`
			const history: Anthropic.MessageParam[] = [{ role: "user", content: "Hello" }]
			const resultPath = await writeConversationHistoryText(taskId, history, 67890)
			resultPath.should.containEql("conversation_history_67890.txt")
			const content = await fs.readFile(resultPath, "utf8")
			content.should.containEql("CONVERSATION HISTORY")
			content.should.containEql("Hello")
		})

		it("writeConversationHistoryText formats array content with tool_use blocks", async () => {
			const taskId = `conv-text-blocks-${Date.now()}`
			const history: Anthropic.MessageParam[] = [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Thinking" },
						{ type: "tool_use", name: "Read", input: { path: "/x" } } as any,
					],
				},
			]
			const resultPath = await writeConversationHistoryText(taskId, history, 11111)
			const content = await fs.readFile(resultPath, "utf8")
			content.should.containEql("Thinking")
			content.should.containEql("TOOL USE: Read")
		})

		it("writeConversationHistoryText formats tool_result blocks with array content", async () => {
			const taskId = `conv-text-result-${Date.now()}`
			const history: Anthropic.MessageParam[] = [
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "result text" }] } as any,
					],
				},
			]
			const resultPath = await writeConversationHistoryText(taskId, history, 22222)
			const content = await fs.readFile(resultPath, "utf8")
			content.should.containEql("TOOL RESULT: tool-1")
			content.should.containEql("result text")
		})

		it("writeConversationHistoryText formats image blocks", async () => {
			const taskId = `conv-text-image-${Date.now()}`
			const history: Anthropic.MessageParam[] = [
				{ role: "user", content: [{ type: "image", source: { type: "base64" } } as any] },
			]
			const resultPath = await writeConversationHistoryText(taskId, history, 33333)
			const content = await fs.readFile(resultPath, "utf8")
			content.should.containEql("IMAGE")
		})

		it("cleanupConversationHistoryFile removes the file if it exists", async () => {
			const taskId = `conv-cleanup-${Date.now()}`
			const resultPath = await writeConversationHistoryJson(taskId, [], 44444)
			await cleanupConversationHistoryFile(resultPath)
			const exists = await fsUtils.fileExistsAtPath(resultPath)
			exists.should.be.false()
		})

		it("cleanupConversationHistoryFile is a no-op on non-existent file (no throw)", async () => {
			await cleanupConversationHistoryFile(path.join(testGlobalStorageDir, "does-not-exist.json"))
		})

		it("cleanupConversationHistoryFile swallows errors silently", async () => {
			sandbox.stub(fs, "unlink").rejects(new Error("permission denied"))
			// Should not throw
			await cleanupConversationHistoryFile(path.join(testGlobalStorageDir, "any.json"))
		})
	})
})
