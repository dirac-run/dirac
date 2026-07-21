import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "mocha"
import should from "should"
import { ensureSqlModule } from "@/shared/sqlJsModule"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { SymbolIndexDatabase } from "../SymbolIndexDatabase"

describe("SymbolIndexDatabase", () => {
	const tempDirectories: string[] = []

	afterEach(async () => {
		await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
	})

	it("persists each committed mutation directly to disk", async () => {
		const { database, databasePath } = await createDatabase()
		database.updateFileSymbols("first.ts", 1.125, 10, [{ n: "first", t: "r", r: [0, 0, 0, 5] }])
		database.updateFileSymbols("second.ts", 1.25, 10, [{ n: "second", t: "r", r: [0, 0, 0, 6] }])

		const secondConnection = await SymbolIndexDatabase.create(databasePath)
		secondConnection.getSymbolsByName("first").length.should.equal(1)
		secondConnection.getSymbolsByName("second").length.should.equal(1)
		secondConnection.getFileMetadata("first.ts")?.mtime.should.equal(1.125)
		secondConnection.close()

		const entries = await fs.readdir(path.dirname(databasePath))
		entries.should.deepEqual(["symbol-index.db"])
		database.close()
	})

	it("opens a legacy sql.js database and removes stale rows without changing retained metadata", async () => {
		const tempDirectory = await makeTempDirectory()
		const databasePath = path.join(tempDirectory, "symbol-index.db")
		await seedLegacyDatabase(databasePath)
		const database = await SymbolIndexDatabase.create(databasePath)

		const result = database.applyMutation({ removals: ["ignored.ts"], replacements: [] })

		result.removed.should.equal(1)
		should(database.getFileMetadata("ignored.ts")).be.null()
		database.getSymbolsByName("ignored").should.be.empty()
		should(database.getFileMetadata("allowed.ts")).deepEqual({ mtime: 1, size: 10 })
		database.getSymbolsByName("allowed").length.should.equal(1)
		database.close()

		const reopened = await SymbolIndexDatabase.create(databasePath)
		should(reopened.getFileMetadata("ignored.ts")).be.null()
		reopened.getSymbolsByName("allowed").length.should.equal(1)
		reopened.close()
	})

	it("creates no files when persistence is disabled", async () => {
		const tempDirectory = await makeTempDirectory()
		const database = await SymbolIndexDatabase.create()
		database.updateFileSymbols("memory.ts", 1, 10, [{ n: "memory", t: "d", r: [0, 0, 0, 6] }])
		database.close()
		;(await fs.readdir(tempDirectory)).should.be.empty()
	})

	it("propagates transaction failures and rolls back partial replacements", async () => {
		const { database } = await createDatabase()
		const invalidReplacement = {
			relPath: "partial.ts",
			mtime: 1,
			size: 10,
			symbols: [{ n: null, t: "d", r: [0, 0, 0, 7] }],
		} as any

		should(() => database.applyMutation({ removals: [], replacements: [invalidReplacement] })).throw()
		should(database.getFileMetadata("partial.ts")).be.null()
		database.getSymbolsByName("partial").should.be.empty()
		database.close()
	})

	it("removes a large explicit path set while preserving retained rows", async () => {
		const { database } = await createDatabase()
		const replacements = Array.from({ length: 1_200 }, (_, index) => ({
			relPath: `source-${index}.ts`,
			mtime: index,
			size: 10,
			symbols: [{ n: `symbol${index}`, t: "d" as const, r: [0, 0, 0, 6] as [number, number, number, number] }],
		}))
		database.applyMutation({ removals: [], replacements })

		const removals = replacements.slice(0, 1_100).map((replacement) => replacement.relPath)
		const result = database.applyMutation({ removals, replacements: [] })

		result.removed.should.equal(1_100)
		should(database.getFileMetadata("source-0.ts")).be.null()
		should(database.getFileMetadata("source-1199.ts")).not.be.null()
		database.getSymbolsByName("symbol0").should.be.empty()
		database.getSymbolsByName("symbol1199").length.should.equal(1)
		database.close()
	})

	it("reports reclaimable pages and compacts a persistent database", async () => {
		const { database, databasePath } = await createDatabase()
		const largeName = "x".repeat(2_048)
		const replacements = Array.from({ length: 4_000 }, (_, index) => ({
			relPath: `large-${index}.ts`,
			mtime: 1,
			size: 10,
			symbols: [{ n: `${largeName}${index}`, t: "d" as const, r: [0, 0, 0, 1] as [number, number, number, number] }],
		}))
		database.applyMutation({ removals: [], replacements })
		database.applyMutation({ removals: replacements.slice(0, 3_900).map(({ relPath }) => relPath), replacements: [] })

		const before = database.getAllocation()
		before.reclaimableBytes.should.be.greaterThan(0)
		database.compact()
		const after = database.getAllocation()

		after.databaseBytes.should.be.lessThan(before.databaseBytes)
		after.freelistCount.should.be.lessThan(before.freelistCount)
		;(await fs.stat(databasePath)).size.should.equal(after.databaseBytes)
		database.close()
	})

	it("quarantines a corrupt derived cache before rebuilding", async () => {
		expectLoggerErrors()
		const tempDirectory = await makeTempDirectory()
		const databasePath = path.join(tempDirectory, "symbol-index.db")
		await fs.writeFile(databasePath, "not sqlite")

		const database = await SymbolIndexDatabase.create(databasePath)
		const entries = await fs.readdir(tempDirectory)
		entries.some((entry) => entry.startsWith("symbol-index.db.corrupt-")).should.be.true()
		database.updateFileSymbols("rebuilt.ts", 1, 10, [{ n: "rebuilt", t: "d", r: [0, 0, 0, 7] }])
		database.close()
	})

	async function createDatabase(): Promise<{ database: SymbolIndexDatabase; databasePath: string }> {
		const tempDirectory = await makeTempDirectory()
		const databasePath = path.join(tempDirectory, "symbol-index.db")
		return { database: await SymbolIndexDatabase.create(databasePath), databasePath }
	}

	async function makeTempDirectory(): Promise<string> {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-index-db-"))
		tempDirectories.push(tempDirectory)
		return tempDirectory
	}

	async function seedLegacyDatabase(databasePath: string): Promise<void> {
		const SQL = await ensureSqlModule()
		const legacy = new SQL.Database()
		legacy.exec(`
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
			INSERT INTO files VALUES ('allowed.ts', 1, 10), ('ignored.ts', 1, 10);
			INSERT INTO symbols (file_path, name, type, start_line, start_column, end_line, end_column)
			VALUES ('allowed.ts', 'allowed', 'definition', 0, 0, 0, 7),
			       ('ignored.ts', 'ignored', 'definition', 0, 0, 0, 7);
		`)
		await fs.writeFile(databasePath, legacy.export())
		legacy.close()
	}
})
