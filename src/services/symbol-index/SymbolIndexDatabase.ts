import { ensureSqlModule, type SqlJsDatabase } from "../../shared/sqlJsModule"
import * as fs from "fs"
import * as path from "path"
import { Logger } from "../../shared/services/Logger"
import { SymbolLocation } from "./SymbolIndexService"

export interface FileMetadata {
    mtime: number
    size: number
}

export class SymbolIndexDatabase {
    private db: SqlJsDatabase
    private dbPath: string

    private constructor(db: SqlJsDatabase, dbPath: string) {
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

        const SQL = await ensureSqlModule()

        try {
            const fileBuffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined
            const db = new SQL.Database(fileBuffer)
            const instance = new SymbolIndexDatabase(db, dbPath)
            instance.initializeSchema()
            return instance
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Failed to open database at ${dbPath}: ${error}`)
            // Fallback to fresh in-memory database
            const db = new SQL.Database()
            const instance = new SymbolIndexDatabase(db, dbPath)
            instance.initializeSchema()
            return instance
        }
    }

    private initializeSchema(): void {
        Logger.info("[SymbolIndexDatabase] Running schema initialization")

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
     * Persist the in-memory database to disk.
     */
    public persist(): void {
        try {
            const data = this.db.export()
            fs.writeFileSync(this.dbPath, Buffer.from(data))
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Error persisting database: ${error}`)
        }
    }

    /**
     * Persist the database to disk. Kept for backward compatibility.
     */
    public save(): void {
        this.persist()
    }

    public getFileMetadata(relPath: string): FileMetadata | null {
        try {
            const stmt = this.db.prepare("SELECT mtime, size FROM files WHERE path = ?")
            try {
                stmt.bind([relPath])
                if (stmt.step()) {
                    const row = stmt.getAsObject() as { mtime: number; size: number }
                    return { mtime: row.mtime, size: row.size }
                }
            } finally {
                stmt.free()
            }
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Error getting file metadata for ${relPath}:`, error)
        }
        return null
    }

    public getAllFilesMetadata(): Map<string, FileMetadata> {
        const map = new Map<string, FileMetadata>()
        try {
            const stmt = this.db.prepare("SELECT path, mtime, size FROM files")
            try {
                while (stmt.step()) {
                    const row = stmt.getAsObject() as { path: string; mtime: number; size: number }
                    map.set(row.path, { mtime: row.mtime, size: row.size })
                }
            } finally {
                stmt.free()
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
        try {
            this.db.run("BEGIN TRANSACTION")
            this.db.run("DELETE FROM symbols WHERE file_path = ?", [relPath])
            this.db.run("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)", [relPath, mtime, size])

            for (const sym of symbols) {
                this.db.run(
                    `INSERT INTO symbols (file_path, name, type, kind, start_line, start_column, end_line, end_column)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        relPath,
                        sym.n,
                        sym.t === "d" ? "definition" : "reference",
                        sym.k || null,
                        sym.r[0],
                        sym.r[1],
                        sym.r[2],
                        sym.r[3],
                    ],
                )
            }
            this.db.run("COMMIT")
            this.persist()
        } catch (error) {
            try { this.db.run("ROLLBACK") } catch { /* ignore rollback error */ }
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
        try {
            this.db.run("BEGIN TRANSACTION")
            for (const update of updates) {
                this.db.run("DELETE FROM symbols WHERE file_path = ?", [update.relPath])
                this.db.run("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)", [
                    update.relPath,
                    update.mtime,
                    update.size,
                ])

                for (const sym of update.symbols) {
                    this.db.run(
                        `INSERT INTO symbols (file_path, name, type, kind, start_line, start_column, end_line, end_column)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            update.relPath,
                            sym.n,
                            sym.t === "d" ? "definition" : "reference",
                            sym.k || null,
                            sym.r[0],
                            sym.r[1],
                            sym.r[2],
                            sym.r[3],
                        ],
                    )
                }
            }
            this.db.run("COMMIT")
            this.persist()
        } catch (error) {
            try { this.db.run("ROLLBACK") } catch { /* ignore rollback error */ }
            Logger.error("[SymbolIndexDatabase] Error updating symbols batch:", error)
        }
    }

    public removeFile(relPath: string): void {
        try {
            this.db.run("DELETE FROM files WHERE path = ?", [relPath])
            this.persist()
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
            const stmt = this.db.prepare(query)
            try {
                stmt.bind(params)
                const rows: SymbolLocation[] = []
                while (stmt.step()) {
                    const row = stmt.getAsObject() as any
                    rows.push({
                        path: row.file_path,
                        startLine: row.start_line,
                        startColumn: row.start_column,
                        endLine: row.end_line,
                        endColumn: row.end_column,
                        type: row.type as "definition" | "reference",
                        kind: row.kind || undefined,
                    })
                }
                return rows
            } finally {
                stmt.free()
            }
        } catch (error) {
            Logger.error(`[SymbolIndexDatabase] Error getting symbols by name ${name}:`, error)
            return []
        }
    }

    public close(): void {
        try {
            this.persist()
            this.db.close()
        } catch (error) {
            Logger.error("[SymbolIndexDatabase] Error closing database:", error)
        }
    }
}
