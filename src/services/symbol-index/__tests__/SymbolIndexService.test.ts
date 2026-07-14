/**
 * Characterization tests for SymbolIndexService.
 * Captures current behavior — bugs and all.
 *
 * Phase 0 — Prerequisite coverage for refactoring
 */
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"

import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { SymbolIndexService, type SymbolLocation } from "../SymbolIndexService"

describe("SymbolIndexService", () => {
	let sandbox: sinon.SinonSandbox
	let mockDb: any

	beforeEach(() => {
		sandbox = sinon.createSandbox()

		// Silence Logger
		sandbox.stub(Logger, "log")
		sandbox.stub(Logger, "error")
		sandbox.stub(Logger, "info")

		// Build mock database
		mockDb = {
			getSymbolsByName: sandbox.stub().returns([]),
			getFileMetadata: sandbox.stub().returns(null),
			updateFileSymbols: sandbox.stub(),
			updateFilesSymbolsBatch: sandbox.stub(),
			removeFile: sandbox.stub(),
			close: sandbox.stub(),
			save: sandbox.stub(),
		}

		// Reset singleton by nulling the instance
		;(SymbolIndexService as any).instance = null
	})

	afterEach(() => {
		sandbox.restore()
	})

	// ---------------------------------------------------------------
	describe("static getInstance", () => {
		it("returns singleton instance", () => {
			const a = SymbolIndexService.getInstance()
			const b = SymbolIndexService.getInstance()
			a.should.equal(b)
			a.should.be.instanceOf(SymbolIndexService)
		})

		it("creates instance on first call", () => {
			;(SymbolIndexService as any).instance = null
			const svc = SymbolIndexService.getInstance()
			svc.should.be.instanceOf(SymbolIndexService)
		})
	})

	// ---------------------------------------------------------------
	describe("getProjectRoot", () => {
		it("returns empty string by default (before initialization)", () => {
			const svc = SymbolIndexService.getInstance()
			svc.getProjectRoot().should.equal("")
		})
	})

	// ---------------------------------------------------------------
	describe("isScanning", () => {
		it("returns false by default", () => {
			const svc = SymbolIndexService.getInstance()
			svc.isScanning().should.be.false()
		})

		it("reflects scanning state when set internally", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).isScanningInternal = true
			svc.isScanning().should.be.true()
		})
	})

	// ---------------------------------------------------------------
	describe("setSkipRepoCheck", () => {
		it("sets skipRepoCheck flag", () => {
			const svc = SymbolIndexService.getInstance()
			svc.setSkipRepoCheck(true)
			;(svc as any).skipRepoCheck.should.be.true()

			svc.setSkipRepoCheck(false)
			;(svc as any).skipRepoCheck.should.be.false()
		})
	})

	// ---------------------------------------------------------------
	describe("setPersistenceEnabled", () => {
		it("sets isPersistenceEnabled flag", () => {
			const svc = SymbolIndexService.getInstance()
			svc.setPersistenceEnabled(false)
			;(svc as any).isPersistenceEnabled.should.be.false()

			svc.setPersistenceEnabled(true)
			;(svc as any).isPersistenceEnabled.should.be.true()
		})
	})

	describe("index storage migration", () => {
		const INDEX_DIR = ".dirac-cache"
		const INDEX_FILE = "symbol-index.db"
		const LEGACY_INDEX_DIR = ".dirac-symbol-index"
		const LEGACY_INDEX_FILE = "data.db"
		let projectRoot: string

		const exists = async (filePath: string): Promise<boolean> => {
			try {
				await fs.access(filePath)
				return true
			} catch {
				return false
			}
		}

		const prepareIndexDir = async (): Promise<void> => {
			const service = SymbolIndexService.getInstance()
			;(service as any).projectRoot = projectRoot
			await (service as any).ensureIndexDir()
		}

		beforeEach(async () => {
			projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-index-"))
		})

		afterEach(async () => {
			await fs.rm(projectRoot, { recursive: true, force: true })
		})

		it("creates only the canonical cache directory when no index exists", async () => {
			await prepareIndexDir()

			;(await exists(path.join(projectRoot, INDEX_DIR))).should.be.true()
			;(await exists(path.join(projectRoot, LEGACY_INDEX_DIR))).should.be.false()
		})

		it("migrates a legacy index directory and database file", async () => {
			const legacyIndexDir = path.join(projectRoot, LEGACY_INDEX_DIR)
			await fs.mkdir(legacyIndexDir)
			await fs.writeFile(path.join(legacyIndexDir, LEGACY_INDEX_FILE), "legacy-index")

			await prepareIndexDir()

			;(await exists(legacyIndexDir)).should.be.false()
			;(await fs.readFile(path.join(projectRoot, INDEX_DIR, INDEX_FILE), "utf8")).should.equal("legacy-index")
		})

		it("keeps an existing canonical index unchanged", async () => {
			const indexDir = path.join(projectRoot, INDEX_DIR)
			await fs.mkdir(indexDir)
			await fs.writeFile(path.join(indexDir, INDEX_FILE), "canonical-index")

			await prepareIndexDir()

			;(await exists(path.join(projectRoot, LEGACY_INDEX_DIR))).should.be.false()
			;(await fs.readFile(path.join(indexDir, INDEX_FILE), "utf8")).should.equal("canonical-index")
		})

		it("removes the legacy directory when both index directories exist", async () => {
			const indexDir = path.join(projectRoot, INDEX_DIR)
			const legacyIndexDir = path.join(projectRoot, LEGACY_INDEX_DIR)
			await fs.mkdir(indexDir)
			await fs.mkdir(legacyIndexDir)
			await fs.writeFile(path.join(indexDir, INDEX_FILE), "canonical-index")
			await fs.writeFile(path.join(legacyIndexDir, LEGACY_INDEX_FILE), "legacy-index")

			await prepareIndexDir()

			;(await exists(legacyIndexDir)).should.be.false()
			;(await fs.readFile(path.join(indexDir, INDEX_FILE), "utf8")).should.equal("canonical-index")
		})
	})

	// ---------------------------------------------------------------
	describe("getSymbols", () => {
		it("returns empty array when db is null", () => {
			const svc = SymbolIndexService.getInstance()
			// db is null by default (not initialized)
			const result = svc.getSymbols("myFunction")
			result.should.be.an.Array()
			result.should.be.empty()
		})

		it("delegates to db.getSymbolsByName with all parameters", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).db = mockDb

			const expected: SymbolLocation[] = [
				{
					path: "src/foo.ts",
					startLine: 10,
					startColumn: 4,
					endLine: 10,
					endColumn: 20,
					type: "definition",
					kind: "function",
				},
			]
			mockDb.getSymbolsByName.returns(expected)

			const result = svc.getSymbols("myFunction", "definition", 50)
			sinon.assert.calledWith(mockDb.getSymbolsByName, "myFunction", "definition", 50)
			result.should.equal(expected)
		})

		it("passes undefined type and limit when not provided", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).db = mockDb

			svc.getSymbols("someSymbol")
			sinon.assert.calledWith(mockDb.getSymbolsByName, "someSymbol", undefined, undefined)
		})
	})

	// ---------------------------------------------------------------
	describe("getReferences", () => {
		it("returns empty array when db is null", () => {
			const svc = SymbolIndexService.getInstance()
			const result = svc.getReferences("myFunction")
			result.should.be.an.Array()
			result.should.be.empty()
		})

		it("calls getSymbols with type 'reference'", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).db = mockDb

			const expected: SymbolLocation[] = [
				{
					path: "src/bar.ts",
					startLine: 5,
					startColumn: 2,
					endLine: 5,
					endColumn: 14,
					type: "reference",
				},
			]
			mockDb.getSymbolsByName.returns(expected)

			const result = svc.getReferences("myFunction", 10)
			sinon.assert.calledWith(mockDb.getSymbolsByName, "myFunction", "reference", 10)
			result.should.equal(expected)
		})

		it("passes undefined limit when not provided", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).db = mockDb

			svc.getReferences("someSymbol")
			sinon.assert.calledWith(mockDb.getSymbolsByName, "someSymbol", "reference", undefined)
		})
	})

	// ---------------------------------------------------------------
	describe("getDefinitions", () => {
		it("returns empty array when db is null", () => {
			const svc = SymbolIndexService.getInstance()
			const result = svc.getDefinitions("myFunction")
			result.should.be.an.Array()
			result.should.be.empty()
		})

		it("calls getSymbols with type 'definition'", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).db = mockDb

			const expected: SymbolLocation[] = [
				{
					path: "src/foo.ts",
					startLine: 10,
					startColumn: 4,
					endLine: 10,
					endColumn: 20,
					type: "definition",
					kind: "function",
				},
			]
			mockDb.getSymbolsByName.returns(expected)

			const result = svc.getDefinitions("myFunction", 100)
			sinon.assert.calledWith(mockDb.getSymbolsByName, "myFunction", "definition", 100)
			result.should.equal(expected)
		})

		it("passes undefined limit when not provided", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).db = mockDb

			svc.getDefinitions("someSymbol")
			sinon.assert.calledWith(mockDb.getSymbolsByName, "someSymbol", "definition", undefined)
		})
	})

	// ---------------------------------------------------------------
	describe("dispose", () => {
		it("closes database when db is set", () => {
			const svc = SymbolIndexService.getInstance()
			;(svc as any).db = mockDb

			svc.dispose()
			sinon.assert.calledOnce(mockDb.close)
			should((svc as any).db).be.null()
		})

		it("does not throw when db is null", () => {
			const svc = SymbolIndexService.getInstance()
			// db is null by default
			svc.dispose()
			// Should not throw
		})

		it("clears save timeout if set", () => {
			const svc = SymbolIndexService.getInstance()
			const clearTimeoutSpy = sandbox.stub(global, "clearTimeout")
			const fakeTimeout = setTimeout(() => {}, 99999) as any
			;(svc as any).saveTimeout = fakeTimeout

			svc.dispose()
			sinon.assert.calledWith(clearTimeoutSpy, fakeTimeout)
			should((svc as any).saveTimeout).be.null()
		})
	})
})
