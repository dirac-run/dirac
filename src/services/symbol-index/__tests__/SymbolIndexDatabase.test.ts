import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { SymbolIndexDatabase } from "../SymbolIndexDatabase"

describe("SymbolIndexDatabase", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirac-symbol-index-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	function dbPath(): string {
		return path.join(tmpDir, ".dirac-symbol-index", "data.db")
	}

	it("refuses to persist a database that exceeds the configured size cap", async () => {
		const db = await SymbolIndexDatabase.create(dbPath(), { maxPersistedBytes: 1 })
		db.updateFileSymbols("src/example.ts", Date.now(), 42, [{ n: "example", t: "d", k: "function", r: [0, 0, 0, 7] }])

		assert.equal(db.save(), false)
		assert.equal(fs.existsSync(dbPath()), false)
		db.close(false)
	})

	it("saves atomically and reloads persisted symbols", async () => {
		const db = await SymbolIndexDatabase.create(dbPath(), { maxPersistedBytes: 1024 * 1024 })
		db.updateFileSymbols("src/example.ts", Date.now(), 42, [{ n: "example", t: "d", k: "function", r: [0, 0, 0, 7] }])

		assert.equal(db.save(), true)
		db.close(false)

		assert.equal(fs.existsSync(dbPath()), true)
		const tempFiles = fs.readdirSync(path.dirname(dbPath())).filter((name) => name.endsWith(".tmp"))
		assert.deepEqual(tempFiles, [])

		const reloaded = await SymbolIndexDatabase.create(dbPath(), { maxPersistedBytes: 1024 * 1024 })
		const symbols = reloaded.getSymbolsByName("example", "definition")
		assert.equal(symbols.length, 1)
		assert.equal(symbols[0].path, "src/example.ts")
		reloaded.close(false)
	})

	it("quarantines oversized existing databases before loading", async () => {
		fs.mkdirSync(path.dirname(dbPath()), { recursive: true })
		fs.writeFileSync(dbPath(), Buffer.alloc(64))

		const db = await SymbolIndexDatabase.create(dbPath(), { maxPersistedBytes: 8 })

		assert.equal(fs.existsSync(dbPath()), false)
		const quarantined = fs.readdirSync(path.dirname(dbPath())).filter((name) => name.includes(".oversized-"))
		assert.equal(quarantined.length, 1)
		db.close(false)
	})

	it("quarantines corrupt existing databases and rebuilds", async () => {
		fs.mkdirSync(path.dirname(dbPath()), { recursive: true })
		fs.writeFileSync(dbPath(), "not a sqlite database")

		const db = await SymbolIndexDatabase.create(dbPath(), { maxPersistedBytes: 1024 * 1024 })

		assert.equal(fs.existsSync(dbPath()), false)
		const quarantined = fs.readdirSync(path.dirname(dbPath())).filter((name) => name.includes(".corrupt-"))
		assert.equal(quarantined.length, 1)
		db.close(false)
	})
})
