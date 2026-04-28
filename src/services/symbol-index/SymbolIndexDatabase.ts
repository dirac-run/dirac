import * as fs from "fs"
import * as path from "path"
import type { Database } from "sql.js"
import initSqlJs from "sql.js"
import { Logger } from "../../shared/services/Logger"
import type { SymbolLocation } from "./SymbolIndexService"

export interface FileMetadata {
	mtime: number
	size: number
}

export interface SymbolIndexDatabaseOptions {
	maxPersistedBytes?: number
}

export interface SymbolIndexDatabaseStats {
	estimatedSizeBytes: number | null
	fileCount: number
	symbolCount: number
}

const CHUNK_SIZE = 1024 * 1024 * 512 // 512 MiB
const DEFAULT_MAX_PERSISTED_BYTES = 128 * 1024 * 1024

function getConfiguredMaxPersistedBytes(): number {
	const raw = process.env.DIRAC_SYMBOL_INDEX_MAX_DB_BYTES
	if (!raw) return DEFAULT_MAX_PERSISTED_BYTES

	const value = Number.parseInt(raw, 10)
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_PERSISTED_BYTES
	return value
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function readFileChunked(filePath: string): Uint8Array {
	const stats = fs.statSync(filePath)
	const fileBuffer = new Uint8Array(stats.size)
	const fd = fs.openSync(filePath, "r")
	try {
		let offset = 0
		while (offset < stats.size) {
			const length = Math.min(CHUNK_SIZE, stats.size - offset)
			fs.readSync(fd, fileBuffer, offset, length, offset)
			offset += length
		}
	} finally {
		fs.closeSync(fd)
	}
	return fileBuffer
}

function writeFileChunked(filePath: string, data: Uint8Array): void {
	const fd = fs.openSync(filePath, "w")
	try {
		let offset = 0
		while (offset < data.length) {
			const length = Math.min(CHUNK_SIZE, data.length - offset)
			fs.writeSync(fd, data, offset, length)
			offset += length
		}
	} finally {
		fs.closeSync(fd)
	}
}

export class SymbolIndexDatabase {
	private db: Database
	private dbPath: string | null
	private isDirty = false
	private maxPersistedBytes: number

	private constructor(db: Database, dbPath: string | null, options: SymbolIndexDatabaseOptions = {}) {
		this.db = db
		this.dbPath = dbPath
		this.maxPersistedBytes = options.maxPersistedBytes ?? getConfiguredMaxPersistedBytes()
	}

	public static async create(dbPath?: string | null, options: SymbolIndexDatabaseOptions = {}): Promise<SymbolIndexDatabase> {
		Logger.info(`[SymbolIndexDatabase] Initializing database${dbPath ? ` at ${dbPath}` : " in memory"}`)

		let skipExistingDb = false
		if (dbPath) {
			const dbDir = path.dirname(dbPath)
			if (!fs.existsSync(dbDir)) {
				Logger.info(`[SymbolIndexDatabase] Creating database directory: ${dbDir}`)
				fs.mkdirSync(dbDir, { recursive: true })
			}

			skipExistingDb = SymbolIndexDatabase.quarantineOversizedExistingDatabase(
				dbPath,
				options.maxPersistedBytes ?? getConfiguredMaxPersistedBytes(),
			)
		}

		const SQL = await initSqlJs({
			locateFile: (file) => path.join(__dirname, file),
		})
		let db: Database

		if (dbPath && !skipExistingDb && fs.existsSync(dbPath)) {
			Logger.info(`[SymbolIndexDatabase] Loading existing database from ${dbPath}`)
			try {
				db = new SQL.Database(readFileChunked(dbPath))
			} catch (error) {
				const corruptPath = `${dbPath}.corrupt-${Date.now()}`
				Logger.error(
					`[SymbolIndexDatabase] Failed to load existing database. Quarantining at ${corruptPath} and rebuilding:`,
					error,
				)
				try {
					fs.renameSync(dbPath, corruptPath)
				} catch (renameError) {
					Logger.error(`[SymbolIndexDatabase] Failed to quarantine corrupt database at ${dbPath}:`, renameError)
				}
				db = new SQL.Database()
			}
		} else {
			Logger.info(`[SymbolIndexDatabase] Creating new database`)
			db = new SQL.Database()
		}

		const instance = new SymbolIndexDatabase(db, dbPath ?? null, options)
		try {
			instance.initialize()
			return instance
		} catch (error) {
			if (!dbPath) {
				throw error
			}

			const corruptPath = `${dbPath}.corrupt-${Date.now()}`
			Logger.error(
				`[SymbolIndexDatabase] Failed to initialize existing database. Quarantining at ${corruptPath} and rebuilding:`,
				error,
			)
			try {
				db.close()
			} catch {
				// Best-effort close before rebuilding.
			}
			try {
				if (fs.existsSync(dbPath)) fs.renameSync(dbPath, corruptPath)
			} catch (renameError) {
				Logger.error(`[SymbolIndexDatabase] Failed to quarantine corrupt database at ${dbPath}:`, renameError)
			}

			const rebuilt = new SymbolIndexDatabase(new SQL.Database(), dbPath, options)
			rebuilt.initialize()
			return rebuilt
		}
	}

	private static quarantineOversizedExistingDatabase(dbPath: string, maxPersistedBytes: number): boolean {
		if (!fs.existsSync(dbPath)) return false

		try {
			const stats = fs.statSync(dbPath)
			if (stats.size <= maxPersistedBytes) return false

			const quarantinePath = `${dbPath}.oversized-${Date.now()}`
			Logger.error(
				`[SymbolIndexDatabase] Existing index database is ${formatBytes(stats.size)}, exceeding max ${formatBytes(maxPersistedBytes)}. Quarantining at ${quarantinePath} and rebuilding.`,
			)
			fs.renameSync(dbPath, quarantinePath)
			return false
		} catch (error) {
			Logger.error(`[SymbolIndexDatabase] Failed to quarantine oversized database at ${dbPath}; skipping load:`, error)
			return true
		}
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

	public save(): boolean {
		if (!this.isDirty) {
			return true
		}
		if (!this.dbPath) {
			this.isDirty = false
			return true
		}

		const stats = this.getStats()
		if (stats.estimatedSizeBytes !== null && stats.estimatedSizeBytes > this.maxPersistedBytes) {
			Logger.error(
				`[SymbolIndexDatabase] Refusing to save oversized symbol index. estimate=${formatBytes(stats.estimatedSizeBytes)} max=${formatBytes(this.maxPersistedBytes)} files=${stats.fileCount} symbols=${stats.symbolCount}`,
			)
			this.isDirty = false
			return false
		}

		let tmpPath: string | null = null
		try {
			Logger.info(`[SymbolIndexDatabase] Saving database to ${this.dbPath}`)
			try {
				this.db.run("VACUUM")
			} catch (error) {
				Logger.warn(`[SymbolIndexDatabase] VACUUM failed: ${error}`)
			}

			const data = this.db.export()
			if (data.byteLength > this.maxPersistedBytes) {
				Logger.error(
					`[SymbolIndexDatabase] Refusing to write oversized exported symbol index. export=${formatBytes(data.byteLength)} max=${formatBytes(this.maxPersistedBytes)} files=${stats.fileCount} symbols=${stats.symbolCount}`,
				)
				this.isDirty = false
				return false
			}

			tmpPath = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`
			writeFileChunked(tmpPath, data)
			fs.renameSync(tmpPath, this.dbPath)
			this.isDirty = false
			Logger.info(`[SymbolIndexDatabase] Database saved successfully (${formatBytes(data.byteLength)})`)
			return true
		} catch (error) {
			Logger.error(`[SymbolIndexDatabase] Failed to save database to ${this.dbPath}:`, error)
			if (tmpPath) {
				try {
					if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
				} catch (cleanupError) {
					Logger.error(`[SymbolIndexDatabase] Failed to remove temporary database ${tmpPath}:`, cleanupError)
				}
			}
			this.isDirty = false
			return false
		}
	}

	private getScalarNumber(query: string): number | null {
		try {
			const result = this.db.exec(query)
			const value = result[0]?.values?.[0]?.[0]
			const num = Number(value)
			return Number.isFinite(num) ? num : null
		} catch {
			return null
		}
	}

	public getStats(): SymbolIndexDatabaseStats {
		const pageCount = this.getScalarNumber("PRAGMA page_count")
		const pageSize = this.getScalarNumber("PRAGMA page_size")
		const fileCount = this.getScalarNumber("SELECT COUNT(*) FROM files") ?? 0
		const symbolCount = this.getScalarNumber("SELECT COUNT(*) FROM symbols") ?? 0

		return {
			estimatedSizeBytes: pageCount !== null && pageSize !== null ? pageCount * pageSize : null,
			fileCount,
			symbolCount,
		}
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
		let insertSymbol: any = null
		try {
			this.db.run("DELETE FROM symbols WHERE file_path = ?", [relPath])
			this.db.run("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)", [relPath, mtime, size])

			insertSymbol = this.db.prepare(`
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
			this.db.run("COMMIT")
		} catch (error) {
			this.db.run("ROLLBACK")
			throw error
		} finally {
			if (insertSymbol) insertSymbol.free()
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

	public close(saveBeforeClose = true): void {
		if (saveBeforeClose) {
			this.save()
		}
		this.db.close()
	}
}
