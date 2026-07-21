import { execFile } from "node:child_process"
import * as syncFs from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import should from "should"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { ensureSqlModule } from "@/shared/sqlJsModule"
import { SymbolIndexDatabase } from "../SymbolIndexDatabase"
import { SymbolIndexService, type SymbolLocation } from "../SymbolIndexService"

const execFileAsync = promisify(execFile)

describe("SymbolIndexService", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(Logger, "log")
		sandbox.stub(Logger, "error")
		sandbox.stub(Logger, "info")
		;(SymbolIndexService as any).instance = null
	})

	afterEach(() => {
		SymbolIndexService.getInstance().dispose()
		sandbox.restore()
	})

	it("returns one service instance", () => {
		SymbolIndexService.getInstance().should.equal(SymbolIndexService.getInstance())
	})

	it("applies the restored standard exclusions by exact path segment", () => {
		const service = SymbolIndexService.getInstance()
		;(service as any).projectRoot = "/workspace"

		service.shouldIndexPath("/workspace/src/dist/file.ts").should.be.false()
		service.shouldIndexPath("/workspace/target/file.rs").should.be.false()
		service.shouldIndexPath("/workspace/generated/file.ts").should.be.false()
		service.shouldIndexPath("/workspace/__generated__/file.ts").should.be.false()
		service.shouldIndexPath("/workspace/vendor/file.php").should.be.false()
		service.shouldIndexPath("/workspace/.venv/file.py").should.be.false()
		service.shouldIndexPath("/workspace/.dirac-cache/file.ts").should.be.false()
		service.shouldIndexPath("/workspace/src/district/file.ts").should.be.true()
		service.shouldIndexPath("/workspace/src/file.zig").should.be.false()
	})

	it("re-queries a lookup only after successful stale deletion", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-stale-"))
		try {
			const service = SymbolIndexService.getInstance()
			;(service as any).projectRoot = projectRoot
			const missingLocation = location("missing.ts")
			const existingLocation = location("existing.ts")
			await fs.writeFile(path.join(projectRoot, "existing.ts"), "export const target = 1\n")
			const db = {
				getSymbolsByName: sandbox
					.stub()
					.onFirstCall()
					.returns([missingLocation])
					.onSecondCall()
					.returns([existingLocation]),
				removeFiles: sandbox.stub().returns(1),
				close: sandbox.stub(),
			}
			;(service as any).db = db

			service.getDefinitions("target", 1).should.deepEqual([existingLocation])
			sinon.assert.calledTwice(db.getSymbolsByName)
			sinon.assert.calledOnceWithExactly(db.removeFiles, ["missing.ts"])
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true })
		}
	})

	it("stops stale cleanup when deletion makes no progress", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-stale-"))
		try {
			const service = SymbolIndexService.getInstance()
			;(service as any).projectRoot = projectRoot
			const missingLocation = location("missing.ts")
			const db = {
				getSymbolsByName: sandbox.stub().returns([missingLocation]),
				removeFiles: sandbox.stub().returns(0),
				close: sandbox.stub(),
			}
			;(service as any).db = db

			service.getDefinitions("target").should.deepEqual([missingLocation])
			sinon.assert.calledOnce(db.getSymbolsByName)
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true })
		}
	})

	it("returns explicit rejected outcomes for oversized and minified files", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-guard-"))
		try {
			const service = SymbolIndexService.getInstance()
			const oversizedPath = path.join(projectRoot, "large.ts")
			await fs.writeFile(oversizedPath, "export const value = 1\n")
			service.setMaxFileSizeBytes(1)
			;(await (service as any).indexFile(oversizedPath, {})).should.deepEqual({
				status: "rejected",
				reason: "oversized",
			})

			service.setMaxFileSizeBytes(1024 * 1024)
			const minifiedPath = path.join(projectRoot, "minified.ts")
			await fs.writeFile(minifiedPath, `const value = "${"x".repeat(5_001)}"`)
			;(await (service as any).indexFile(minifiedPath, {})).should.deepEqual({
				status: "rejected",
				reason: "generated or minified",
			})
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true })
		}
	})

	it("returns retry when a source changes during parsing", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-changing-"))
		try {
			const service = SymbolIndexService.getInstance()
			const filePath = path.join(projectRoot, "changing.ts")
			await fs.writeFile(filePath, "export const before = 1\n")
			const tree = { rootNode: {}, delete: sandbox.stub() }
			const parser = {
				parse: sandbox.stub().callsFake(() => {
					syncFs.writeFileSync(filePath, "export const afterValue = 2\n")
					return tree
				}),
			}
			const query = { captures: sandbox.stub().returns([]) }

			const outcome = await (service as any).indexFile(filePath, { ts: { parser, query } })

			outcome.should.deepEqual({ status: "retry" })
			sinon.assert.calledOnce(tree.delete)
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true })
		}
	})

	it("coalesces concurrent reconciliation requests into one run and one queued rerun", async () => {
		const service = SymbolIndexService.getInstance()
		;(service as any).db = { close: sandbox.stub() }
		;(service as any).eligibility = {}
		let releaseFirst!: () => void
		const firstRun = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const reconcile = sandbox.stub(service as any, "reconcile")
		reconcile.onFirstCall().returns(firstRun)
		reconcile.onSecondCall().resolves(false)

		const active = service.requestReconciliation("first")
		void service.requestReconciliation("second")
		void service.requestReconciliation("third")
		releaseFirst()
		await active

		reconcile.callCount.should.equal(2)
		reconcile.secondCall.calledWith("third").should.be.true()
	})

	it("serializes watcher mutations behind an active reconciliation", async () => {
		const service = SymbolIndexService.getInstance()
		;(service as any).db = { close: sandbox.stub() }
		;(service as any).eligibility = {}
		let releaseReconciliation!: () => void
		const reconciliationBlocked = new Promise<void>((resolve) => {
			releaseReconciliation = resolve
		})
		const reconcile = sandbox.stub(service as any, "reconcile").returns(reconciliationBlocked)
		const watcherUpdate = sandbox.stub(service as any, "applyWatcherEventsSerially").resolves()

		const reconciliation = service.requestReconciliation("first")
		const watcher = (service as any).applyWatcherEvents([{ absolutePath: "/workspace/a.ts", kind: "upsert" }])
		await Promise.resolve()
		watcherUpdate.notCalled.should.be.true()

		releaseReconciliation()
		await Promise.all([reconciliation, watcher])
		sinon.assert.calledOnce(reconcile)
		sinon.assert.calledOnce(watcherUpdate)
	})

	it("evicts a previously indexed file when watcher parsing deliberately rejects it", async () => {
		const service = SymbolIndexService.getInstance()
		;(service as any).projectRoot = "/workspace"
		;(service as any).eligibility = {
			admitsRelativePath: sandbox.stub().returns(true),
			enumerate: sandbox.stub().resolves({
				paths: new Set(["rejected.ts"]),
				watchDirectories: new Set(),
				isGitWorkspace: true,
				gitDirectory: "/workspace/.git",
			}),
		}
		const applyMutation = sandbox.stub().returns({ changed: true, removed: 1, replaced: 0 })
		;(service as any).db = {
			applyMutation,
			close: sandbox.stub(),
		}
		sandbox.stub(service as any, "stageFiles").resolves({
			replacements: [],
			rejectedPaths: ["rejected.ts"],
			retryRequested: false,
		})

		await (service as any).applyWatcherEvents([{ absolutePath: "/workspace/rejected.ts", kind: "upsert" }])

		applyMutation.firstCall.args[0].removals.should.deepEqual(["rejected.ts"])
	})

	it("uses no cache directory or shutdown write when persistence is disabled", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-memory-"))
		try {
			const service = SymbolIndexService.getInstance()
			service.setSkipRepoCheck(true)
			service.setPersistenceEnabled(false)
			await service.initialize(projectRoot)
			service.dispose()
			const entries = await fs.readdir(projectRoot)
			entries.includes(".dirac-cache").should.be.false()
		} finally {
			await fs.rm(projectRoot, { recursive: true, force: true })
		}
	})

	it("splits large eligibility cleanup into yielding in-memory transactions", async () => {
		const service = SymbolIndexService.getInstance()
		const metadata = new Map(
			Array.from({ length: 1_250 }, (_, index) => [`ignored-${index}.ts`, { mtime: 1, size: 1 }] as const),
		)
		let eventLoopMarkerRan = false
		setImmediate(() => {
			eventLoopMarkerRan = true
		})
		const applyMutation = sandbox.stub().callsFake((mutation) => {
			if (applyMutation.callCount > 1) eventLoopMarkerRan.should.be.true()
			return {
				changed: mutation.removals.length > 0 || mutation.replacements.length > 0,
				removed: mutation.removals.length,
				replaced: mutation.replacements.length,
			}
		})
		const db = {
			getAllFilesMetadata: sandbox.stub().returns(metadata),
			applyMutation,
			close: sandbox.stub(),
			getAllocation: sandbox.stub().returns({
				pageSize: 4_096,
				pageCount: 1,
				freelistCount: 0,
				databaseBytes: 4_096,
				reclaimableBytes: 0,
			}),
			compact: sandbox.stub(),
		}
		;(service as any).projectRoot = "/workspace"
		;(service as any).eligibility = {
			enumerate: sandbox.stub().resolves({
				paths: new Set(),
				watchDirectories: new Set(),
				isGitWorkspace: true,
				gitDirectory: "/workspace/.git",
			}),
		}
		;(service as any).db = db
		const yieldAfterMutationBatch = sandbox.spy(service as any, "yieldAfterMutationBatch")

		;(await (service as any).reconcile("large cleanup")).should.be.true()

		applyMutation.callCount.should.equal(13)
		applyMutation
			.getCalls()
			.every((call) => call.args[0].removals.length <= 100)
			.should.be.true()
		applyMutation
			.getCalls()
			.flatMap((call) => call.args[0].removals)
			.should.have.length(1_250)
		yieldAfterMutationBatch.callCount.should.equal(13)
	})
	it("compacts only when both reclaimable-byte and free-ratio thresholds are met", () => {
		const service = SymbolIndexService.getInstance()
		const compact = sandbox.stub()
		const getAllocation = sandbox.stub()
		getAllocation.onFirstCall().returns({
			pageSize: 4_096,
			pageCount: 20_000,
			freelistCount: 18_000,
			databaseBytes: 81_920_000,
			reclaimableBytes: 73_728_000,
		})
		getAllocation.onSecondCall().returns({
			pageSize: 4_096,
			pageCount: 2_000,
			freelistCount: 0,
			databaseBytes: 8_192_000,
			reclaimableBytes: 0,
		})
		const db = { getAllocation, compact, close: sandbox.stub() }
		;(service as any).db = db

		;(service as any).compactDatabaseIfNeeded(db, "test")

		sinon.assert.calledOnce(compact)
		sinon.assert.calledTwice(getAllocation)
	})

	it("stages and applies large candidate sets without retaining more than ten files", async () => {
		const service = SymbolIndexService.getInstance()
		const applyMutation = sandbox.stub().callsFake((mutation) => ({
			changed: mutation.removals.length > 0 || mutation.replacements.length > 0,
			removed: mutation.removals.length,
			replaced: mutation.replacements.length,
		}))
		const db = {
			applyMutation,
			close: sandbox.stub(),
		}
		;(service as any).db = db
		const stageFiles = sandbox.stub(service as any, "stageFiles").callsFake(async (...args: unknown[]) => {
			const batch = args[0] as Array<{ absolutePath: string; relPath: string }>
			return {
				replacements: batch.map((candidate) => ({
					relPath: candidate.relPath,
					mtime: 1,
					size: 1,
					symbols: [],
				})),
				rejectedPaths: [],
				retryRequested: false,
			}
		})
		const yieldAfterMutationBatch = sandbox.spy(service as any, "yieldAfterMutationBatch")
		const candidates = Array.from({ length: 25 }, (_, index) => ({
			absolutePath: `/workspace/source-${index}.ts`,
			relPath: `source-${index}.ts`,
		}))

		const result = await (service as any).applyCandidateBatches(db, candidates, "large candidate test")

		result.should.deepEqual({ changed: true, removed: 0, replaced: 25, retryRequested: false })
		stageFiles.callCount.should.equal(3)
		stageFiles
			.getCalls()
			.every((call) => call.args[0].length <= 10)
			.should.be.true()
		applyMutation.callCount.should.equal(3)
		applyMutation
			.getCalls()
			.every((call) => call.args[0].replacements.length <= 10)
			.should.be.true()
		yieldAfterMutationBatch.callCount.should.equal(3)
	})

	it("stops cleanup after disposal is observed between batches", async () => {
		const service = SymbolIndexService.getInstance()
		const db = {
			applyMutation: sandbox.stub().callsFake((mutation) => ({
				changed: true,
				removed: mutation.removals.length,
				replaced: 0,
			})),
			close: sandbox.stub(),
		}
		;(service as any).db = db
		sandbox.stub(service as any, "yieldAfterMutationBatch").callsFake(async () => {
			;(service as any).disposed = true
		})

		const removed = await (service as any).applyRemovalBatches(
			db,
			Array.from({ length: 300 }, (_, index) => `ignored-${index}.ts`),
			"dispose test",
		)

		removed.should.equal(100)
		db.applyMutation.callCount.should.equal(1)
	})

	it("purges a large ignored legacy index in bounded transactions without reparsing retained files", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-legacy-"))
		try {
			await execFileAsync("git", ["init", "-q"], { cwd: projectRoot })
			await fs.writeFile(path.join(projectRoot, ".gitignore"), "ignored-*.ts\n")
			await fs.writeFile(path.join(projectRoot, "allowed.ts"), "export const allowed = 1\n")
			const allowedStats = await fs.stat(path.join(projectRoot, "allowed.ts"))
			const cacheDirectory = path.join(projectRoot, ".dirac-cache")
			await fs.mkdir(cacheDirectory)
			await seedLegacyDatabase(path.join(cacheDirectory, "symbol-index.db"), allowedStats.mtimeMs, allowedStats.size, 1_205)

			const applyMutation = sandbox.spy(SymbolIndexDatabase.prototype, "applyMutation")
			const service = SymbolIndexService.getInstance()
			const stageFiles = sandbox.spy(service as any, "stageFiles")
			await service.initialize(projectRoot)
			const database = (service as any).db

			stageFiles.notCalled.should.be.true()
			const removalCalls = applyMutation.getCalls().filter((call) => call.args[0].removals.length > 0)
			removalCalls.length.should.equal(13)
			removalCalls.every((call) => call.args[0].removals.length <= 100).should.be.true()
			removalCalls.flatMap((call) => call.args[0].removals).should.have.length(1_205)
			should(database.getFileMetadata("ignored-0.ts")).be.null()
			database.getSymbolsByName("ignored0").should.be.empty()
			database.getSymbolsByName("allowed").should.not.be.empty()
			const cacheEntries = await fs.readdir(cacheDirectory)
			cacheEntries.some((entry) => entry.startsWith("symbol-index.db.tmp-")).should.be.false()

			await service.requestReconciliation("periodic repair")
			applyMutation.callCount.should.equal(13)
		} finally {
			SymbolIndexService.getInstance().dispose()
			await fs.rm(projectRoot, { recursive: true, force: true })
		}
	})

	it("removes newly ignored files and indexes newly unignored files on reconciliation", async () => {
		const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-ignore-change-"))
		try {
			await execFileAsync("git", ["init", "-q"], { cwd: projectRoot })
			await fs.writeFile(path.join(projectRoot, "dynamic.ts"), "export const dynamic = 1\n")
			const service = SymbolIndexService.getInstance()
			await service.initialize(projectRoot)
			const database = (service as any).db
			database.getFileMetadata("dynamic.ts").should.not.be.null()

			await fs.writeFile(path.join(projectRoot, ".gitignore"), "dynamic.ts\n")
			await service.requestReconciliation("test newly ignored")
			should(database.getFileMetadata("dynamic.ts")).be.null()

			await fs.writeFile(path.join(projectRoot, ".gitignore"), "")
			await service.requestReconciliation("test newly unignored")
			database.getFileMetadata("dynamic.ts").should.not.be.null()
		} finally {
			SymbolIndexService.getInstance().dispose()
			await fs.rm(projectRoot, { recursive: true, force: true })
		}
	})

	function location(filePath: string): SymbolLocation {
		return {
			path: filePath,
			startLine: 0,
			startColumn: 0,
			endLine: 0,
			endColumn: 6,
			type: "definition",
		}
	}

	async function seedLegacyDatabase(
		databasePath: string,
		allowedMtime: number,
		allowedSize: number,
		ignoredFileCount: number,
	): Promise<void> {
		const SQL = await ensureSqlModule()
		const database = new SQL.Database()
		database.exec(`
			CREATE TABLE files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL);
			CREATE TABLE symbols (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				file_path TEXT NOT NULL,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				kind TEXT,
				start_line INTEGER NOT NULL,
				start_column INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				end_column INTEGER NOT NULL
			);
		`)
		const insertFile = database.prepare("INSERT INTO files VALUES (?, ?, ?)")
		const insertSymbol = database.prepare(
			"INSERT INTO symbols (file_path, name, type, start_line, start_column, end_line, end_column) VALUES (?, ?, 'definition', 0, 0, 0, 7)",
		)
		try {
			insertFile.run(["allowed.ts", allowedMtime, allowedSize])
			insertSymbol.run(["allowed.ts", "allowed"])
			for (let index = 0; index < ignoredFileCount; index++) {
				const relativePath = `ignored-${index}.ts`
				insertFile.run([relativePath, 1, 1])
				insertSymbol.run([relativePath, `ignored${index}`])
			}
		} finally {
			insertFile.free()
			insertSymbol.free()
		}
		await fs.writeFile(databasePath, database.export())
		database.close()
	}
})
