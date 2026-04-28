import * as fs from "fs"
import * as path from "path"
import type { Database } from "sql.js"
import initSqlJs from "sql.js"
import { Logger } from "../../shared/services/Logger"
import { SymbolLocation } from "./SymbolIndexService"

export interface FileMetadata {
	mtime: number
	size: number
}

export class SymbolIndexDatabase {
	private db: Database
	private dbPath: string
	private isDirty = false

	private constructor(db: Database, dbPath: string) {
		this.db = db
		this.dbPath = dbPath
	}

	public static async create(dbPath: string): Promise<SymbolIndexDatabase> {
		Logger.info(`[SymbolIndexDatabase] Initializing database at ${dbPath}`)
		const dbDir = path.dirname(dbPath)
		if (!fs.existsSync(dbDir)) {
			Logger.info(`[SymbolIndexDatabase] Creating database directory: ${dbDir}`)
			fs.mkdirSync(dbDir, { recursive: true })
		}

		const SQL = await initSqlJs({
			locateFile: (file) => path.join(__dirname, file),
		})
		let db: Database

		if (fs.existsSync(dbPath)) {
			try {
				Logger.info(`[SymbolIndexDatabase] Loading existing database from ${dbPath}`)
				const stats = fs.statSync(dbPath)
				const size = stats.size
				const fileBuffer = new Uint8Array(size)
				const fd = fs.openSync(dbPath, "r")
				try {
					let offset = 0
					const chunkSize = 1024 * 1024 * 512 // 512MB chunks
					while (offset < size) {
						const length = Math.min(chunkSize, size - offset)
						fs.readSync(fd, fileBuffer, offset, length, offset)
						offset += length
					}
				} finally {
					fs.closeSync(fd)
				}
				db = new SQL.Database(fileBuffer)
			} catch (error) {
				Logger.error(`[SymbolIndexDatabase] Failed to load database from ${dbPath}: ${error}. Creating new database.`)
				db = new SQL.Database()
			}
		} else {
			Logger.info(`[SymbolIndexDatabase] Creating new database`)
			db = new SQL.Database()
		}

		const instance = new SymbolIndexDatabase(db, dbPath)
		instance.initialize()
		return instance
	}

	private initialize(): void {
		Logger.info("[SymbolIndexDatabase] Running schema initialization")
		this.db.run("PRAGMA foreign_keys = ON")

		this.db.run(`
			CREATE TABLE IF NOT EXISTS files (
				path TEXT PRIMARY KEY,
				mtime INTEGER NOT NULL,
				size INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS symbols (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				file_path TEXT NOT NULL,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				kind TEXT,
				start_line INTEGER NOT NULL,
				start_column INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				end_column INTEGER NOT NULL,
				FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
			CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
		`)
		Logger.info("[SymbolIndexDatabase] Schema initialization complete")
	}

	public save(): void {
		if (!this.isDirty) {
			return
		}
		Logger.info(`[SymbolIndexDatabase] Saving database to ${this.dbPath}`)
		try {
			this.db.run("VACUUM")
		} catch (error) {
			Logger.warn(`[SymbolIndexDatabase] VACUUM failed: ${error}`)
		}
		const data = this.db.export()
		const fd = fs.openSync(this.dbPath, "w")
		try {
			let offset = 0
			const chunkSize = 1024 * 1024 * 512 // 512MB chunks
			while (offset < data.length) {
				const length = Math.min(chunkSize, data.length - offset)
				fs.writeSync(fd, data, offset, length)
				offset += length
			}
		} finally {
			fs.closeSync(fd)
		}
		this.isDirty = false
		Logger.info(`[SymbolIndexDatabase] Database saved successfully`)
	}

	public getFileMetadata(relPath: string): FileMetadata | null {
		const stmt = this.db.prepare("SELECT mtime, size FROM files WHERE path = ?")
		stmt.bind([relPath])
		if (stmt.step()) {
			const result = stmt.getAsObject() as any
			stmt.free()
			return { mtime: result.mtime, size: result.size }
		}
		stmt.free()
		return null
	}

	public getAllFilesMetadata(): Map<string, FileMetadata> {
		const stmt = this.db.prepare("SELECT path, mtime, size FROM files")
		const map = new Map<string, FileMetadata>()
		while (stmt.step()) {
			const row = stmt.getAsObject() as any
			map.set(row.path, { mtime: row.mtime, size: row.size })
		}
		stmt.free()
		return map
	}

	public updateFileSymbols(
		relPath: string,
		mtime: number,
		size: number,
		symbols: Array<{
			n: string
			t: "d" | "r"
			k?: string
			r: [number, number, number, number]
		}>,
	): void {
		this.isDirty = true
		this.db.run("BEGIN TRANSACTION")
		try {
			this.db.run("DELETE FROM symbols WHERE file_path = ?", [relPath])
			this.db.run("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)", [relPath, mtime, size])

			const insertSymbol = this.db.prepare(`
				INSERT INTO symbols (file_path, name, type, kind, start_line, start_column, end_line, end_column)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)

			for (const sym of symbols) {
				insertSymbol.run([
					relPath,
					sym.n,
					sym.t === "d" ? "definition" : "reference",
					sym.k || null,
					sym.r[0],
					sym.r[1],
					sym.r[2],
					sym.r[3],
				])
			}
			insertSymbol.free()
			this.db.run("COMMIT")
		} catch (error) {
			this.db.run("ROLLBACK")
			throw error
		}
	}

	public updateFilesSymbolsBatch(
		updates: Array<{
			relPath: string
			mtime: number
			size: number
			symbols: Array<{
				n: string
				t: "d" | "r"
				k?: string
				r: [number, number, number, number]
			}>
		}>,
	): void {
		this.isDirty = true
		this.db.run("BEGIN TRANSACTION")
		let insertSymbol: any = null
		let deleteSymbols: any = null
		let insertFile: any = null
		try {
			insertSymbol = this.db.prepare(`
				INSERT INTO symbols (file_path, name, type, kind, start_line, start_column, end_line, end_column)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
			deleteSymbols = this.db.prepare("DELETE FROM symbols WHERE file_path = ?")
			insertFile = this.db.prepare("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)")

			for (const update of updates) {
				deleteSymbols.run([update.relPath])
				insertFile.run([update.relPath, update.mtime, update.size])

				for (const sym of update.symbols) {
					insertSymbol.run([
						update.relPath,
						sym.n,
						sym.t === "d" ? "definition" : "reference",
						sym.k || null,
						sym.r[0],
						sym.r[1],
						sym.r[2],
						sym.r[3],
					])
				}
			}
			this.db.run("COMMIT")
		} catch (error) {
			this.db.run("ROLLBACK")
			throw error
		} finally {
			if (insertSymbol) insertSymbol.free()
			if (deleteSymbols) deleteSymbols.free()
			if (insertFile) insertFile.free()
		}
	}

	public removeFile(relPath: string): void {
		this.isDirty = true
		this.db.run("DELETE FROM files WHERE path = ?", [relPath])
	}

		public getSymbolsByName(name: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
		let query =
			"SELECT file_path, name, type, kind, start_line, start_column, end_line, end_column FROM symbols WHERE name = ?"
		const params: any[] = [name]

		if (type) {
			query += " AND type = ?"
			params.push(type)
		}

		if (limit !== undefined) {
			query += " LIMIT ?"
			params.push(limit)
		}

		const stmt = this.db.prepare(query)
		stmt.bind(params)
		const results: SymbolLocation[] = []
		while (stmt.step()) {
			const row = stmt.getAsObject() as any
			results.push({
				path: row.file_path,
				startLine: row.start_line,
				startColumn: row.start_column,
				endLine: row.end_line,
				endColumn: row.end_column,
				type: row.type as "definition" | "reference",
				kind: row.kind || undefined,
			})
		}
		stmt.free()
		return results
	}

	public close(): void {
		this.save()
		this.db.close()
	}
}
