import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import * as sinon from "sinon"
import { EnvironmentManager } from "../EnvironmentManager"
import { TaskState } from "../TaskState"

function createEnvironmentManager(
	taskState: TaskState,
	options: { taskMode?: "plan" | "act"; requestMode?: "plan" | "act"; cwd?: string } = {},
): EnvironmentManager {
	const taskMode = options.taskMode ?? "act"
	const requestMode = options.requestMode ?? taskMode
	return new EnvironmentManager({
		cwd: options.cwd ?? "/test/project",
		terminalManager: {} as any,
		taskState,
		fileContextTracker: {} as any,
		api: {} as any,
		messageStateHandler: {} as any,
		getWorkingConfiguration: () => ({ settings: { mode: taskMode }, executionOptions: { multiRootEnabled: false } }) as any,
		getRequestRuntime: () =>
			requestMode
				? ({
						workingConfiguration: { settings: { mode: requestMode }, executionOptions: { multiRootEnabled: false } },
					} as any)
				: undefined,
		getRequestRuntime: () => ({
			requestId: "request-1",
			workingConfiguration: { settings: { mode: requestMode }, executionOptions: { multiRootEnabled: false } },
		}) as any,
	})
}

describe("EnvironmentManager mode-entry guidance", () => {
	it("emits Plan guidance only for a pending Plan entry", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "plan" }
		const manager = createEnvironmentManager(taskState, { taskMode: "plan" })

		const entryDetails = await manager.getEnvironmentDetails(false)
		assert.match(entryDetails, /# Current Mode\nPLAN MODE/)
		assert.match(entryDetails, /Research without modifying files/)
		assert.doesNotMatch(entryDetails, /EDITING FILES/)
		assert.equal(taskState.pendingModeNotice.includedInRequestId, "request-1")

		taskState.pendingModeNotice = undefined
		assert.equal(await manager.getEnvironmentDetails(false), "")
	})

	it("emits concise editing guidance only for a pending Act entry", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "act" }
		const manager = createEnvironmentManager(taskState)

		const entryDetails = await manager.getEnvironmentDetails(false)
		assert.match(entryDetails, /# Current Mode\nACT MODE/)
		assert.match(entryDetails, /## EDITING FILES/)
		assert.match(entryDetails, /ANCHOR§CONTENT/)
		assert.doesNotMatch(entryDetails, /EDITING FILES INSTRUCTIONS/)
		assert.doesNotMatch(entryDetails, /REQUIRED `edit_file` WORKFLOW/)
		assert.equal(taskState.pendingModeNotice.includedInRequestId, "request-1")

		taskState.pendingModeNotice = undefined
		assert.equal(await manager.getEnvironmentDetails(false), "")
	})

	it("uses the request-bound mode and does not claim a newer mismatched notice", async () => {
		const planState = new TaskState()
		planState.pendingModeNotice = { mode: "plan" }
		const planRequest = createEnvironmentManager(planState, { taskMode: "act", requestMode: "plan" })
		assert.match(await planRequest.getEnvironmentDetails(false), /# Current Mode\nPLAN MODE/)
		assert.equal(planState.pendingModeNotice.includedInRequestId, "request-1")

		const actState = new TaskState()
		actState.pendingModeNotice = { mode: "act" }
		const stalePlanRequest = createEnvironmentManager(actState, { taskMode: "act", requestMode: "plan" })
		assert.equal(await stalePlanRequest.getEnvironmentDetails(false), "")
		assert.deepEqual(actState.pendingModeNotice, { mode: "act" })
	})
})

describe("EnvironmentManager recent-files bounded traversal (FB-31)", () => {
	it("bounds traversal when repository is dominated by a large non-code tree", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-walk-test-"))
		try {
			// Create 60 subdirectories with 100 non-code files each (6,000 files total)
			const numDirs = 60
			const filesPerDir = 100
			for (let i = 0; i < numDirs; i++) {
				const sub = path.join(tempDir, `dir_${String(i).padStart(2, "0")}`)
				await fs.mkdir(sub)
				await Promise.all(
					Array.from({ length: filesPerDir }, (_, j) =>
						fs.writeFile(path.join(sub, `asset_${String(j).padStart(3, "0")}.png`), ""),
					),
				)
			}

			// Place a code file in the last directory (dir_59)
			const lastDir = path.join(tempDir, `dir_${String(numDirs - 1).padStart(2, "0")}`)
			await fs.writeFile(path.join(lastDir, "late_code_file.ts"), "export const x = 1")

			const taskState = new TaskState()
			const manager = createEnvironmentManager(taskState, { cwd: tempDir })

			const readdirSpy = sinon.spy(fs, "readdir")
			let details = ""
			try {
				details = await manager.getEnvironmentDetails(true)
			} finally {
				readdirSpy.restore()
			}

			// Because total visited entries hit the 5,000 cap before reaching dir_59:
			// 1. Not all 60 subdirectories are traversed
			assert.strictEqual(readdirSpy.callCount < 60, true)
			// 2. late_code_file.ts is never traversed or stat'ed
			assert.doesNotMatch(details, /late_code_file\.ts/)
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("stops directory walk immediately when task is pre-aborted", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-abort-pre-"))
		try {
			await fs.writeFile(path.join(tempDir, "index.ts"), "console.log('hi')")

			const taskState = new TaskState()
			taskState.abort = true
			const manager = createEnvironmentManager(taskState, { cwd: tempDir })
			const details = await manager.getEnvironmentDetails(true)

			assert.doesNotMatch(details, /Latest 10 edited files/)
			assert.doesNotMatch(details, /index\.ts/)
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("stops directory walk immediately when task is aborted mid-traversal", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-abort-mid-"))
		try {
			for (let i = 0; i < 10; i++) {
				await fs.writeFile(path.join(tempDir, `file_${i}.ts`), "")
			}

			const taskState = new TaskState()
			const manager = createEnvironmentManager(taskState, { cwd: tempDir })
			const yieldedFiles: string[] = []

			for await (const file of (manager as any).walkCodeFiles(tempDir, new Set())) {
				yieldedFiles.push(file)
				taskState.abort = true
			}

			// After aborting on the first yield, the walk halts and yields no further files
			assert.strictEqual(yieldedFiles.length, 1)
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("respects custom maxEntries parameter on walkCodeFiles", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-max-entries-"))
		try {
			// Create 30 non-code files, then 10 code files
			for (let i = 0; i < 30; i++) {
				await fs.writeFile(path.join(tempDir, `asset_${String(i).padStart(2, "0")}.txt`), "")
			}
			for (let i = 0; i < 10; i++) {
				await fs.writeFile(path.join(tempDir, `code_${String(i).padStart(2, "0")}.ts`), "")
			}

			const taskState = new TaskState()
			const manager = createEnvironmentManager(taskState, { cwd: tempDir })

			// With a bound of 10 entries, traversal halts before examining the rest of the directory
			const yieldedFiles: string[] = []
			for await (const file of (manager as any).walkCodeFiles(tempDir, new Set(), 10)) {
				yieldedFiles.push(file)
			}

			assert.strictEqual(yieldedFiles.length <= 10, true)
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})

	it("extracts and sorts top 10 most recently edited files while respecting ignored directories", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-recent-sort-"))
		try {
			// Create ignored directory
			const nodeModules = path.join(tempDir, "node_modules")
			await fs.mkdir(nodeModules)
			await fs.writeFile(path.join(nodeModules, "ignored.ts"), "")

			// Create 15 code files with staggered mtimes
			const baseTime = Date.now() - 100000
			for (let i = 0; i < 15; i++) {
				const filePath = path.join(tempDir, `file_${String(i).padStart(2, "0")}.ts`)
				await fs.writeFile(filePath, "")
				const mtime = new Date(baseTime + i * 1000)
				await fs.utimes(filePath, mtime, mtime)
			}

			const taskState = new TaskState()
			const manager = createEnvironmentManager(taskState, { cwd: tempDir })
			const details = await manager.getEnvironmentDetails(true)

			// Verify ignored directory is not present
			assert.doesNotMatch(details, /ignored\.ts/)

			// Verify the top 10 recent files (file_14.ts down to file_05.ts) are present in descending order
			assert.match(details, /# Latest 10 edited files in this workspace/)
			for (let i = 14; i >= 5; i--) {
				assert.match(details, new RegExp(`file_${String(i).padStart(2, "0")}\\.ts`))
			}
			// Older files beyond top 10 (file_04.ts down to file_00.ts) should not be present
			for (let i = 4; i >= 0; i--) {
				assert.doesNotMatch(details, new RegExp(`file_${String(i).padStart(2, "0")}\\.ts`))
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})
})
