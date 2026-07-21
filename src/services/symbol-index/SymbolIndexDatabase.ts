import * as fs from "node:fs"
import * as path from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { Logger } from "../../shared/services/Logger"
import type { SymbolLocation } from "./SymbolIndexService"
import { SymbolIndexTelemetry } from "./SymbolIndexTelemetry"

export interface FileMetadata {
	mtime: number
	size: number
}

export interface FileSymbolReplacement {
	relPath: string
	mtime: number
	size: number
	symbols: Array<{
		n: string
		t: "d" | "r"
		k?: string
		r: [number, number, number, number]
	}>
}

export interface SymbolIndexDatabaseMutation {
	removals: readonly string[]
	replacements: readonly FileSymbolReplacement[]
}

export interface SymbolIndexDatabaseMutationResult {
	changed: boolean
	removed: number
	replaced: number
}

export interface SymbolIndexDatabaseAllocation {
	pageSize: number
	pageCount: number
	freelistCount: number
	databaseBytes: number
	reclaimableBytes: number
}

export class SymbolIndexDatabase {
	private constructor(
		private readonly db: DatabaseSync,
		private readonly location: string,
	) {
		this.initializeSchema()
	}

	public static async create(dbPath?: string): Promise<SymbolIndexDatabase> {
		if (!dbPath) return SymbolIndexDatabase.open(":memory:")

		Logger.info(`[SymbolIndexDatabase] Initializing database at ${dbPath}`)
		fs.mkdirSync(path.dirname(dbPath), { recursive: true })
		try {
			return SymbolIndexDatabase.open(dbPath)
		} catch (error) {
			if (!SymbolIndexDatabase.isCorruptDatabaseError(error)) throw error
			const quarantinePath = `${dbPath}.corrupt-${Date.now()}`
			fs.renameSync(dbPath, quarantinePath)
			Logger.error(`[SymbolIndexDatabase] Quarantined corrupt database at ${quarantinePath}: ${error}`)
			SymbolIndexTelemetry.recordFailure()
			return SymbolIndexDatabase.open(dbPath)
		}
	}

	public getAllFilesMetadata(): Map<string, FileMetadata> {
		const metadata = new Map<string, FileMetadata>()
		for (const row of this.db.prepare("SELECT path, mtime, size FROM files").iterate()) {
			metadata.set(row.path as string, { mtime: row.mtime as number, size: row.size as number })
		}
		return metadata
	}

	public getFileMetadata(relPath: string): FileMetadata | null {
		const row = this.db.prepare("SELECT mtime, size FROM files WHERE path = ?").get(relPath)
		if (!row) return null
		return { mtime: row.mtime as number, size: row.size as number }
	}

	public updateFileSymbols(relPath: string, mtime: number, size: number, symbols: FileSymbolReplacement["symbols"]): void {
		this.applyMutation({
			removals: [],
			replacements: [{ relPath, mtime, size, symbols }],
		})
	}

	public applyMutation(mutation: SymbolIndexDatabaseMutation): SymbolIndexDatabaseMutationResult {
		this.db.exec("BEGIN IMMEDIATE")
		try {
			const removed = this.deleteFiles(mutation.removals)
			this.replaceFiles(mutation.replacements)
			this.db.exec("COMMIT")
			return {
				changed: removed > 0 || mutation.replacements.length > 0,
				removed,
				replaced: mutation.replacements.length,
			}
		} catch (error) {
			try {
				this.db.exec("ROLLBACK")
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Symbol index transaction and rollback failed")
			}
			throw error
		}
	}

	public removeFile(relPath: string): boolean {
		return this.removeFiles([relPath]) > 0
	}

	public removeFiles(relPaths: readonly string[]): number {
		return this.applyMutation({ removals: relPaths, replacements: [] }).removed
	}

	public getSymbolsByName(name: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
		let query = "SELECT file_path, type, kind, start_line, start_column, end_line, end_column FROM symbols WHERE name = ?"
		const parameters: Array<string | number> = [name]
		if (type) {
			query += " AND type = ?"
			parameters.push(type)
		}
		if (limit !== undefined) {
			query += " LIMIT ?"
			parameters.push(limit)
		}

		return [...this.db.prepare(query).iterate(...parameters)].map((row) => ({
			path: row.file_path as string,
			startLine: row.start_line as number,
			startColumn: row.start_column as number,
			endLine: row.end_line as number,
			endColumn: row.end_column as number,
			type: row.type as "definition" | "reference",
			kind: (row.kind as string | null) ?? undefined,
		}))
	}

	public getAllocation(): SymbolIndexDatabaseAllocation {
		const pageSize = this.readPragmaNumber("page_size")
		const pageCount = this.readPragmaNumber("page_count")
		const freelistCount = this.readPragmaNumber("freelist_count")
		return {
			pageSize,
			pageCount,
			freelistCount,
			databaseBytes: pageSize * pageCount,
			reclaimableBytes: pageSize * freelistCount,
		}
	}

	public compact(): void {
		if (this.location === ":memory:") return
		this.db.exec("VACUUM")
	}

	public close(): void {
		this.db.close()
	}

	private static open(location: string): SymbolIndexDatabase {
		const database = new DatabaseSync(location)
		try {
			return new SymbolIndexDatabase(database, location)
		} catch (error) {
			database.close()
			throw error
		}
	}

	private static isCorruptDatabaseError(error: unknown): boolean {
		const errorCode = (error as { errcode?: number }).errcode
		return errorCode === 11 || errorCode === 26
	}

	private readPragmaNumber(name: "page_size" | "page_count" | "freelist_count"): number {
		const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, number>
		return row[name]
	}

	private initializeSchema(): void {
		this.db.exec(`
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;
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
	}

	private deleteFiles(relPaths: readonly string[]): number {
		if (relPaths.length === 0) return 0
		const deleteSymbols = this.db.prepare("DELETE FROM symbols WHERE file_path = ?")
		const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?")
		let removed = 0
		for (const relPath of relPaths) {
			deleteSymbols.run(relPath)
			removed += Number(deleteFile.run(relPath).changes)
		}
		return removed
	}

	private replaceFiles(replacements: readonly FileSymbolReplacement[]): void {
		if (replacements.length === 0) return
		const deleteSymbols = this.db.prepare("DELETE FROM symbols WHERE file_path = ?")
		const upsertFile = this.db.prepare("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)")
		const insertSymbol = this.db.prepare(`
			INSERT INTO symbols (file_path, name, type, kind, start_line, start_column, end_line, end_column)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`)
		for (const replacement of replacements) {
			deleteSymbols.run(replacement.relPath)
			upsertFile.run(replacement.relPath, replacement.mtime, replacement.size)
			this.insertSymbols(insertSymbol, replacement)
		}
	}

	private insertSymbols(statement: StatementSync, replacement: FileSymbolReplacement): void {
		for (const symbol of replacement.symbols) {
			statement.run(
				replacement.relPath,
				symbol.n,
				symbol.t === "d" ? "definition" : "reference",
				symbol.k ?? null,
				symbol.r[0],
				symbol.r[1],
				symbol.r[2],
				symbol.r[3],
			)
		}
	}
}
