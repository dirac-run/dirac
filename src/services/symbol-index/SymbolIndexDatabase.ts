import Database from "better-sqlite3"
import * as fs from "fs"
import * as path from "path"
import { Logger } from "../../shared/services/Logger"
import { resolveSqliteNativeBinding } from "../../shared/sqliteNativeBinding"
import { SymbolLocation } from "./SymbolIndexService"

export interface FileMetadata {
    mtime: number
    size: number
}

export class SymbolIndexDatabase {
    private db: Database.Database
    private dbPath: string

    private constructor(db: Database.Database, dbPath: string) {
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

        const nativeBinding = resolveSqliteNativeBinding()

        try {
            const dbOptions = nativeBinding ? { nativeBinding } : {}
            const db = new Database(dbPath, dbOptions)
            // Use WAL mode for better performance and concurrency
            db.pragma("journal_mode = WAL")
            db.pragma("synchronous = NORMAL")
            const instance = new SymbolIndexDatabase(db, dbPath)
            instance.initialize()
            return instance
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Failed to open database at ${dbPath}: ${error}`)
            // Fallback to in-memory database if file-based fails
            const dbOptions = nativeBinding ? { nativeBinding } : {}
            const db = new Database(":memory:", dbOptions)
            const instance = new SymbolIndexDatabase(db, dbPath)
            instance.initialize()
            return instance
        }
    }

    private initialize(): void {
        Logger.info("[SymbolIndexDatabase] Running schema initialization")
        this.db.pragma("foreign_keys = ON")

        this.db.exec(`
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

    /**
     * No-op for better-sqlite3 as it handles persistence automatically.
     * Kept for backward compatibility with SymbolIndexService.
     */
    public save(): void {
        // better-sqlite3 handles persistence automatically
    }

    public getFileMetadata(relPath: string): FileMetadata | null {
        try {
            const row = this.db.prepare("SELECT mtime, size FROM files WHERE path = ?").get(relPath) as any
            if (row) {
                return { mtime: row.mtime, size: row.size }
            }
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Error getting file metadata for ${relPath}:`, error)
        }
        return null
    }

    public getAllFilesMetadata(): Map<string, FileMetadata> {
        const map = new Map<string, FileMetadata>()
        try {
            const rows = this.db.prepare("SELECT path, mtime, size FROM files").all() as any[]
            for (const row of rows) {
                map.set(row.path, { mtime: row.mtime, size: row.size })
            }
        } catch (error) {
            Logger.error("[SymbolIndexDatabase] Error getting all files metadata:", error)
        }
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
        const deleteSymbols = this.db.prepare("DELETE FROM symbols WHERE file_path = ?")
        const insertFile = this.db.prepare("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)")
        const insertSymbol = this.db.prepare(`
			INSERT INTO symbols (file_path, name, type, kind, start_line, start_column, end_line, end_column)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`)

        const transaction = this.db.transaction(() => {
            deleteSymbols.run(relPath)
            insertFile.run(relPath, mtime, size)

            for (const sym of symbols) {
                insertSymbol.run(
                    relPath,
                    sym.n,
                    sym.t === "d" ? "definition" : "reference",
                    sym.k || null,
                    sym.r[0],
                    sym.r[1],
                    sym.r[2],
                    sym.r[3],
                )
            }
        })

        try {
            transaction()
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Error updating symbols for ${relPath}:`, error)
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
        const deleteSymbols = this.db.prepare("DELETE FROM symbols WHERE file_path = ?")
        const insertFile = this.db.prepare("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)")
        const insertSymbol = this.db.prepare(`
			INSERT INTO symbols (file_path, name, type, kind, start_line, start_column, end_line, end_column)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`)

        const transaction = this.db.transaction((batch) => {
            for (const update of batch) {
                deleteSymbols.run(update.relPath)
                insertFile.run(update.relPath, update.mtime, update.size)

                for (const sym of update.symbols) {
                    insertSymbol.run(
                        update.relPath,
                        sym.n,
                        sym.t === "d" ? "definition" : "reference",
                        sym.k || null,
                        sym.r[0],
                        sym.r[1],
                        sym.r[2],
                        sym.r[3],
                    )
                }
            }
        })

        try {
            transaction(updates)
        } catch (error) {
            Logger.error("[SymbolIndexDatabase] Error updating symbols batch:", error)
        }
    }

    public removeFile(relPath: string): void {
        try {
            this.db.prepare("DELETE FROM files WHERE path = ?").run(relPath)
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Error removing file ${relPath}:`, error)
        }
    }

    public getSymbolsByName(name: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
        let query = "SELECT file_path, name, type, kind, start_line, start_column, end_line, end_column FROM symbols WHERE name = ?"
        const params: any[] = [name]

        if (type) {
            query += " AND type = ?"
            params.push(type === "definition" ? "definition" : "reference")
        }

        if (limit !== undefined) {
            query += " LIMIT ?"
            params.push(limit)
        }

        try {
            const rows = this.db.prepare(query).all(...params) as any[]
            return rows.map((row) => ({
                path: row.file_path,
                startLine: row.start_line,
                startColumn: row.start_column,
                endLine: row.end_line,
                endColumn: row.end_column,
                type: row.type as "definition" | "reference",
                kind: row.kind || undefined,
            }))
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Error getting symbols by name ${name}:`, error)
            return []
        }
    }

    public close(): void {
        try {
            this.db.close()
        } catch (error) {
            Logger.error("[SymbolIndexDatabase] Error closing database:", error)
        }
    }
}
