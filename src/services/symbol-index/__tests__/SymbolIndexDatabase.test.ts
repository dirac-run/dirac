import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "mocha"
import "should"
import { SymbolIndexDatabase } from "../SymbolIndexDatabase"

describe("SymbolIndexDatabase", () => {
	const tempDirectories: string[] = []

	afterEach(async () => {
		await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
	})

	it("removes file metadata and its symbol rows without relying on foreign-key cascades", async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-index-db-"))
		tempDirectories.push(tempDirectory)
		const database = await SymbolIndexDatabase.create(path.join(tempDirectory, "symbol-index.db"))
		database.updateFileSymbols("deleted.ts", 1, 10, [
			{
				n: "deletedSymbol",
				t: "r",
				r: [0, 0, 0, 13],
			},
		])

		database.removeFile("deleted.ts").should.be.true()
		should(database.getFileMetadata("deleted.ts")).be.null()
		database.getSymbolsByName("deletedSymbol").should.be.empty()
		database.close()
	})

	it("removes a batch of files with one database persist", async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-index-db-"))
		tempDirectories.push(tempDirectory)
		const database = await SymbolIndexDatabase.create(path.join(tempDirectory, "symbol-index.db"))
		const internalDatabase = database as any
		let persistCalls = 0
		const originalPersist = internalDatabase.persist.bind(database)
		internalDatabase.persist = () => {
			persistCalls++
			originalPersist()
		}
		database.updateFileSymbols("first.ts", 1, 10, [{ n: "first", t: "r", r: [0, 0, 0, 5] }])
		database.updateFileSymbols("second.ts", 1, 10, [{ n: "second", t: "r", r: [0, 0, 0, 6] }])
		persistCalls = 0

		database.removeFiles(["first.ts", "second.ts"]).should.equal(2)

		persistCalls.should.equal(1)
		database.getSymbolsByName("first").should.be.empty()
		database.getSymbolsByName("second").should.be.empty()
		database.close()
	})
})
