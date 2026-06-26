import { ensureSqlModule, type SqlJsDatabase } from "@/shared/sqlJsModule"
import * as fs from "fs"
import { existsSync, mkdirSync, unlinkSync } from "fs"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"

import type { LockRow, SqliteLockManagerOptions } from "./types"

export class SqliteLockManager {
	private db!: SqlJsDatabase
	private instanceAddress: string
	private dbPath: string
	private readonly STALE_LOCK_TIMEOUT = 1 * 60 * 1000 // 1 minute in milliseconds

	private constructor(options: SqliteLockManagerOptions) {
		this.instanceAddress = options.instanceAddress
		this.dbPath = options.dbPath
	}

	public static async create(options: SqliteLockManagerOptions): Promise<SqliteLockManager> {
		const instance = new SqliteLockManager(options)

		// Ensure the directory exists before creating the database
		const dbDir = path.dirname(instance.dbPath)
		try {
			mkdirSync(dbDir, { recursive: true })
		} catch (error) {
			Logger.error(`CRITICAL ERROR: Failed to create SQLite database directory ${dbDir}:`, error)
			throw new Error(`Failed to create SQLite database directory: ${error}`)
		}

		try {
			await instance.initializeDatabaseWithLock()
		} catch (error) {
			Logger.error(`CRITICAL ERROR: Failed to initialize SQLite database at ${instance.dbPath}:`, error)
			throw new Error(`Failed to initialize SQLite database: ${error}`)
		}

		return instance
	}

	private async initializeDatabaseWithLock(): Promise<void> {
		const lockFile = `${this.dbPath}.lock`

		// Clean up stale lock files first
		this.cleanupStaleLockSync(lockFile)

		try {
			// Try to acquire exclusive file lock for database creation
			let fd: number | null = null

			try {
				fd = fs.openSync(lockFile, "wx") // Exclusive creation - fails if file exists

				// Write timestamp to lock file for stale lock detection
				fs.writeFileSync(fd, Date.now().toString())

				const SQL = await ensureSqlModule()

				// Open existing database file or create new one
				const fileBuffer = existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined
				const dbExists = !!fileBuffer

				this.db = new SQL.Database(fileBuffer)

				if (!dbExists) {
					this.initializeDatabase()
					this.persistDb()
				}
			} finally {
				// Always clean up the lock file
				if (fd !== null) {
					fs.closeSync(fd)
				}
				try {
					unlinkSync(lockFile)
				} catch {} // Ignore errors if file was already deleted
			}
		} catch (error: any) {
			if (error.code === "EEXIST") {
				// Another process is initializing the database, wait and retry
				const delay = 100 + Math.random() * 100 // Add jitter
				this.sleepSync(delay)
				await this.initializeDatabaseWithLock()
				return
			}
			throw error
		}
	}

	private sleepSync(ms: number) {
		// Non-spinning, synchronous sleep using Atomics.wait
		// Works in Node main thread (since v12.16+) and worker threads.
		const sab = new SharedArrayBuffer(4)
		const ia = new Int32Array(sab)
		Atomics.wait(ia, 0, 0, Math.max(0, Math.floor(ms)))
	}

	private cleanupStaleLockSync(lockFile: string): void {
		try {
			if (!existsSync(lockFile)) {
				return // Lock file doesn't exist, nothing to clean up
			}

			try {
				const timestampStr = fs.readFileSync(lockFile, "utf8").trim()
				const timestamp = Number.parseInt(timestampStr, 10)

				if (isNaN(timestamp) || Date.now() - timestamp > this.STALE_LOCK_TIMEOUT) {
					// Stale lock, remove it
					unlinkSync(lockFile)
					Logger.warn(`Removed stale database lock file: ${lockFile}`)
				}
			} catch (readError) {
				// If we can't read the timestamp, assume it's stale
				unlinkSync(lockFile)
				Logger.warn(`Removed unreadable database lock file: ${lockFile}`)
			}
		} catch (error: any) {
			if (error.code !== "ENOENT") {
				// Lock file doesn't exist, which is fine
				Logger.warn(`Error checking lock file ${lockFile}:`, error)
			}
		}
	}

	private initializeDatabase() {
		// Create the locks table with the unified schema (matches cli/pkg/common/schema.go)
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS locks (
				id INTEGER PRIMARY KEY,
				held_by TEXT NOT NULL,
				lock_type TEXT NOT NULL CHECK (lock_type IN ('file', 'instance', 'folder')),
				lock_target TEXT NOT NULL,
				locked_at INTEGER NOT NULL,
				UNIQUE(lock_type, lock_target)
			);
		`)

		// Create indexes for performance (matches cli/pkg/common/schema.go)
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_locks_held_by ON locks(held_by);
			CREATE INDEX IF NOT EXISTS idx_locks_type ON locks(lock_type);
			CREATE INDEX IF NOT EXISTS idx_locks_target ON locks(lock_target);
		`)
	}

	/**
	 * Persist the in-memory database to disk.
	 */
	private persistDb(): void {
		try {
			const data = this.db.export()
			fs.writeFileSync(this.dbPath, Buffer.from(data))
		} catch (error) {
			Logger.error(`[SqliteLockManager] Error persisting database:`, error)
		}
	}

	/**
	 * Register this instance in the locks table
	 */
	async registerInstance(data: { hostAddress: string }): Promise<void> {
		const now = Date.now()

		this.db.run(
			`INSERT OR REPLACE INTO locks (held_by, lock_type, lock_target, locked_at)
			 VALUES (?, 'instance', ?, ?)`,
			[this.instanceAddress, data.hostAddress, now],
		)
		this.persistDb()
	}

	/**
	 * Update the timestamp for this instance (touch)
	 */
	touchInstance(): void {
		const now = Date.now()
		this.db.run(`UPDATE locks SET locked_at = ? WHERE held_by = ? AND lock_type = 'instance'`, [now, this.instanceAddress])
		this.persistDb()
	}

	/**
	 * Remove this instance from the locks table
	 */
	unregisterInstance(): void {
		this.db.run(`DELETE FROM locks WHERE held_by = ? AND lock_type = 'instance'`, [this.instanceAddress])
		this.persistDb()
	}

	/**
	 * Query the registry for any instance registered on the given port
	 */
	getInstanceByPort(port: number): { instanceAddress: string; hostAddress: string } | null {
		const stmt = this.db.prepare(
			`SELECT held_by, lock_target FROM locks 
			 WHERE lock_type = 'instance' 
			 AND (held_by LIKE '%:' || ? OR lock_target LIKE '%:' || ?)`,
		)
		try {
			stmt.bind([port, port])

			if (stmt.step()) {
				const result = stmt.getAsObject() as { held_by: string; lock_target: string }
				return {
					instanceAddress: result.held_by,
					hostAddress: result.lock_target,
				}
			}
			return null
		} finally {
			stmt.free()
		}
	}

	/**
	 * Remove a specific instance entry from the registry
	 */
	removeInstanceByAddress(instanceAddress: string): void {
		this.db.run(`DELETE FROM locks WHERE held_by = ? AND lock_type = 'instance'`, [instanceAddress])
		this.persistDb()
	}

	/**
	 * Check if another instance has a conflicting folder lock
	 */
	async getFolderLockByTarget(lockTarget: string): Promise<LockRow | null> {
		const stmt = this.db.prepare(`SELECT * FROM locks WHERE lock_type = 'folder' AND lock_target = ?`)
		try {
			stmt.bind([lockTarget])

			if (stmt.step()) {
				const result = stmt.getAsObject() as unknown as LockRow
				return result
			}
			return null
		} finally {
			stmt.free()
		}
	}

	/**
	 * Release a folder lock
	 */
	releaseFolderLockByTarget(heldBy: string, lockTarget: string): void {
		// swap instance address in place of taskID
		heldBy = this.instanceAddress
		this.db.run(`DELETE FROM locks WHERE held_by = ? AND lock_type = 'folder' AND lock_target = ?`, [heldBy, lockTarget])
		this.persistDb()
	}

	/**
	 * Register a folder lock
	 * @returns null if lock was successfully acquired, or the conflicting LockRow if lock already exists
	 */
	async registerFolderLock(heldBy: string, lockTarget: string): Promise<LockRow | null> {
		const now = Date.now()

		// swap instance address in place of taskID
		heldBy = this.instanceAddress

		this.db.run(
			`INSERT OR IGNORE INTO locks (held_by, lock_type, lock_target, locked_at)
             VALUES (?, 'folder', ?, ?)`,
			[this.instanceAddress, lockTarget, now],
		)

		const changes = this.db.getRowsModified()

		this.persistDb()

		if (changes > 0) {
			return null // lock acquired
		}
		const existingLock = await this.getFolderLockByTarget(lockTarget)
		if (existingLock && existingLock.held_by === heldBy) {
			return null // existing lock is held by the same task
		}
		// existing lock held by other task, return the conflicting lock
		return await this.getFolderLockByTarget(lockTarget)
	}

	/**
	 * Clean up folder locks that are held by tasks whose instances no longer exist.
	 * This removes locks where held_by doesn't exist in any instance-type lock.
	 */
	cleanupOrphanedFolderLocks(): void {
		this.db.exec(`
            DELETE FROM locks
            WHERE lock_type = 'folder'
            AND held_by NOT IN (
                SELECT DISTINCT held_by
                FROM locks
                WHERE lock_type = 'instance'
            )
        `)

		const deletedCount = this.db.getRowsModified()
		this.persistDb()

		if (deletedCount > 0) {
			Logger.log(`Cleaned up ${deletedCount} orphaned folder lock(s)`)
		}
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		this.persistDb()
		this.db.close()
	}
}
