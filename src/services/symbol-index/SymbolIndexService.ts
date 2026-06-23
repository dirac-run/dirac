import { loadRequiredLanguageParsers } from "@services/tree-sitter/languageParser"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "../../shared/services/Logger"
import { SymbolIndexDatabase } from "./SymbolIndexDatabase"
import { SymbolIndexParser } from "./SymbolIndexParser"
import { SymbolIndexQuery } from "./SymbolIndexQuery"

export interface SymbolLocation {
	path: string
	startLine: number
	startColumn: number
	endLine: number
	endColumn: number
	type: "definition" | "reference"
	kind?: string // e.g., "function", "class", "method"
}

export interface FileIndexEntry {
	mtime: number
	size: number
	hash: string
	symbols: Array<{
		n: string // name
		t: "d" | "r" // type: definition or reference
		k?: string // kind
		r: [number, number, number, number] // range: [startLine, startColumn, endLine, endColumn]
	}>
}

export interface PersistentIndex {
	version: number
	files: Record<string, FileIndexEntry>
}

/**
 * Facade over the symbol index: owns lifecycle (init, persistence, dispose) and
 * delegates parsing to {@link SymbolIndexParser} and lookups to {@link SymbolIndexQuery}.
 */
export class SymbolIndexService {
	private static instance: SymbolIndexService | null = null

	public static getInstance(): SymbolIndexService {
		if (!SymbolIndexService.instance) {
			SymbolIndexService.instance = new SymbolIndexService()
		}
		return SymbolIndexService.instance
	}

	private static readonly INDEX_DIR = ".dirac-symbol-index"
	private static readonly INDEX_FILE = "data.db"

	private projectRoot = ""
	private db: SymbolIndexDatabase | null = null
	private saveTimeout: NodeJS.Timeout | null = null
	private isScanningInternal = false
    private isFullScanInProgress = false
	private isPersistenceEnabled = true
	private skipRepoCheck = false

	private parser: SymbolIndexParser
	private query: SymbolIndexQuery

	private constructor() {
		this.parser = new SymbolIndexParser(SymbolIndexService.INDEX_DIR)
		this.query = new SymbolIndexQuery(() => this.db)
	}

	public getProjectRoot(): string {
		return this.projectRoot
	}

	public isScanning(): boolean {
		return this.isScanningInternal
	}

	public setSkipRepoCheck(skip: boolean): void {
		this.skipRepoCheck = skip
	}

	public setPersistenceEnabled(enabled: boolean): void {
		this.isPersistenceEnabled = enabled
	}

	private async isRepository(dirPath: string): Promise<boolean> {
		const vcsDirs = [".git", ".hg", ".svn"]
		for (const vcs of vcsDirs) {
			try {
				await fs.access(path.join(dirPath, vcs))
				return true
			} catch {
				// Continue checking
			}
		}
		return false
	}

	async initialize(projectRoot: string): Promise<void> {
		Logger.info(`[SymbolIndexService] Initializing for root: ${projectRoot}`)
		if (this.isScanningInternal && this.projectRoot === projectRoot) {
			Logger.info("[SymbolIndexService] Already scanning this root, skipping")
			return
		}

		const isRepo = this.skipRepoCheck || (await this.isRepository(projectRoot))
		if (!isRepo) {
			Logger.info(
				`[SymbolIndexService] ${projectRoot} is not a repository. Skipping indexing to prevent performance issues.`,
			)
			return
		}

		this.isScanningInternal = true
		try {
			const oldRoot = this.projectRoot
			this.projectRoot = projectRoot

			if (oldRoot !== projectRoot) {
				Logger.info(`[SymbolIndexService] Root changed from ${oldRoot} to ${projectRoot}`)
				this.parser.reset()

				if (this.db) {
					Logger.info("[SymbolIndexService] Closing old database")
					this.db.close()
					this.db = null
				}

				if (this.isPersistenceEnabled) {
					await this.ensureIndexDir()
					await this.excludeIndexDirFromGit()
				}
				const dbPath = path.join(this.projectRoot, SymbolIndexService.INDEX_DIR, SymbolIndexService.INDEX_FILE)
				Logger.info(`[SymbolIndexService] Creating database instance at ${dbPath}`)
				this.db = await SymbolIndexDatabase.create(dbPath)
			}
			this.isFullScanInProgress = true
			Logger.info("[SymbolIndexService] Starting full scan")
			const root = projectRoot
			await this.parser.runFullScan(projectRoot, this.db, () => this.projectRoot !== root)
			Logger.info("[SymbolIndexService] Full scan completed")
		} finally {
			this.isFullScanInProgress = false
			this.isScanningInternal = false
		}
	}

	private async ensureIndexDir(): Promise<void> {
		if (!this.isPersistenceEnabled) return
		const dirPath = path.join(this.projectRoot, SymbolIndexService.INDEX_DIR)
		Logger.info(`[SymbolIndexService] Ensuring index directory: ${dirPath}`)
		try {
			await fs.access(dirPath)
			Logger.info("[SymbolIndexService] Index directory already exists")
		} catch {
			Logger.info("[SymbolIndexService] Creating index directory")
			await fs.mkdir(dirPath, { recursive: true })
			Logger.info("[SymbolIndexService] Index directory created")
		}
	}

	private async excludeIndexDirFromGit(): Promise<void> {
		const gitDir = path.join(this.projectRoot, ".git")
		const excludePath = path.join(gitDir, "info", "exclude")

		try {
			await fs.access(gitDir)
		} catch {
			// Not a git repository, skip
			return
		}

		try {
			// Ensure info directory exists
			await fs.mkdir(path.join(gitDir, "info"), { recursive: true })

			let content = ""
			try {
				content = await fs.readFile(excludePath, "utf8")
			} catch {
				// File doesn't exist, will create it
			}

			const lines = content.split(/\r?\n/)
			const entry = `${SymbolIndexService.INDEX_DIR}/`
			if (!lines.some((line) => line.trim() === entry || line.trim() === SymbolIndexService.INDEX_DIR)) {
				Logger.info(`[SymbolIndexService] Adding ${entry} to .git/info/exclude`)
				const newContent = content.endsWith("\n") || content === "" ? `${content + entry}\n` : `${content}\n${entry}\n`
				await fs.writeFile(excludePath, newContent)
			}
		} catch (error) {
			Logger.error("[SymbolIndexService] Failed to update .git/info/exclude:", error)
		}
	}

	public getSymbols(symbol: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
		return this.query.getSymbols(symbol, type, limit)
	}

	public getReferences(symbol: string, limit?: number): SymbolLocation[] {
		return this.query.getReferences(symbol, limit)
	}

	public getDefinitions(symbol: string, limit?: number): SymbolLocation[] {
		return this.query.getDefinitions(symbol, limit)
	}

	async updateFile(absolutePath: string): Promise<void> {
		if (!this.parser.shouldIndexFile(absolutePath)) return

		try {
			const relPath = path.relative(this.projectRoot, absolutePath)
			const languageParsers = await loadRequiredLanguageParsers([absolutePath])
			const entry = await this.parser.indexFile(absolutePath, languageParsers)
			if (entry && this.db) {
				this.db.updateFileSymbols(relPath, entry.mtime, entry.size, entry.symbols)
			}
		} catch (error) {
			Logger.error(`[SymbolIndexService] Error updating file ${absolutePath}:`, error)
		}
	}

	async removeFile(absolutePath: string): Promise<void> {
		const relPath = path.relative(this.projectRoot, absolutePath)
		this.db?.removeFile(relPath)
	}

	public dispose(): void {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout)
			this.saveTimeout = null
		}
		if (this.db) {
			this.db.close()
			this.db = null
		}
	}
}
