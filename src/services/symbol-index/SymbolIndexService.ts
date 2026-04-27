import { loadRequiredLanguageParsers } from "@services/tree-sitter/languageParser"
import * as fs from "fs/promises"
import pLimit from "p-limit"
import * as path from "path"
import Parser from "web-tree-sitter"
import { Logger } from "../../shared/services/Logger"
import { SymbolIndexDatabase } from "./SymbolIndexDatabase"

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

export class SymbolIndexService {
	private static instance: SymbolIndexService | null = null

	public static getInstance(): SymbolIndexService {
		if (!SymbolIndexService.instance) {
			SymbolIndexService.instance = new SymbolIndexService()
		}
		return SymbolIndexService.instance
	}

	private static readonly EXCLUDED_DIRS = new Set([
		"node_modules",
		".git",
		".github",
		".vscode",
		".cursor",
		".dirac",
		"out",
		"dist",
		"dist-standalone",
		"build",
		"target",
		"bin",
		"obj",
		"__pycache__",
		".venv",
		"venv",
		"env",
		".env",
		".cache",
		".next",
		".nuxt",
		".svelte-kit",
		"coverage",
		"tmp",
		"temp",
		"vendor",
		"generated",
		"__generated__",
		"artifacts",
	])

	private static readonly EXCLUDED_FILES = new Set([
		"package-lock.json",
		"yarn.lock",
		"pnpm-lock.yaml",
		"composer.lock",
		"Gemfile.lock",
		"Cargo.lock",
		"go.sum",
		"poetry.lock",
		"mix.lock",
	])

	private static readonly SUPPORTED_EXTENSIONS = [
		"js",
		"jsx",
		"ts",
		"tsx",
		"py",
		"rs",
		"go",
		"c",
		"h",
		"cpp",
		"hpp",
		"cs",
		"rb",
		"java",
		"php",
		"swift",
		"kt",
	]

	private static readonly MAX_FILE_SIZE = 1024 * 1024 // 1MB

	// Performance and behavior constants
	private static readonly FILES_PER_BATCH = 50
	private static readonly PARALLEL_PARSING_LIMIT = 10
	private static readonly INDEX_DIR = ".dirac-symbol-index"
	private static readonly INDEX_FILE = "data.db"
	private static readonly SAVE_DEBOUNCE_MS = 2000
	private static readonly VERSION = 1

	private projectRoot = ""
	private db: SymbolIndexDatabase | null = null
	private saveTimeout: NodeJS.Timeout | null = null
	private isScanningInternal = false
	private isFullScanInProgress = false
	private scanQueue: { absolutePath: string; relPath: string }[] = []
	private isPersistenceEnabled = true
	private pendingUpdates: Set<string> = new Set()

	private constructor() {}

	public getProjectRoot(): string {
		return this.projectRoot
	}

	public isScanning(): boolean {
		return this.isScanningInternal
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

		const isRepo = await this.isRepository(projectRoot)
		if (!isRepo) {
			Logger.info(`[SymbolIndexService] ${projectRoot} is not a repository. Skipping indexing to prevent performance issues.`)
			return
		}


		this.isScanningInternal = true
		try {
			const oldRoot = this.projectRoot
			this.projectRoot = projectRoot

			if (oldRoot !== projectRoot) {
				Logger.info(`[SymbolIndexService] Root changed from ${oldRoot} to ${projectRoot}`)
				this.scanQueue = []
				this.pendingUpdates.clear()

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
			await this.runFullScan()
			Logger.info("[SymbolIndexService] Full scan completed")
			this.scheduleSave()
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
			const entry = SymbolIndexService.INDEX_DIR + "/"
			if (!lines.some((line) => line.trim() === entry || line.trim() === SymbolIndexService.INDEX_DIR)) {
				Logger.info(`[SymbolIndexService] Adding ${entry} to .git/info/exclude`)
				const newContent = content.endsWith("\n") || content === "" ? content + entry + "\n" : content + "\n" + entry + "\n"
				await fs.writeFile(excludePath, newContent)
			}
		} catch (error) {
			Logger.error("[SymbolIndexService] Failed to update .git/info/exclude:", error)
		}
	}

	private isExcluded(name: string): boolean {
		if (SymbolIndexService.EXCLUDED_DIRS.has(name)) return true
		if (name === SymbolIndexService.INDEX_DIR) return true
		if (name.startsWith(".") && !name.startsWith(".dirac")) return true
		return false
	}

	private shouldIndexFile(relPath: string): boolean {
		const parts = relPath.split(path.sep)
		for (const part of parts) {
			if (this.isExcluded(part)) return false
		}

		const fileName = path.basename(relPath)
		if (SymbolIndexService.EXCLUDED_FILES.has(fileName)) return false

		const ext = path.extname(relPath).toLowerCase().slice(1)
		return SymbolIndexService.SUPPORTED_EXTENSIONS.includes(ext)
	}

	private async runFullScan(): Promise<void> {
		Logger.info("[SymbolIndexService] Starting runFullScan")
		const root = this.projectRoot
		this.scanQueue = [{ absolutePath: root, relPath: "" }]

		let filesChecked = 0
		let filesIndexed = 0
		const limit = pLimit(SymbolIndexService.PARALLEL_PARSING_LIMIT)

		let queueIndex = 0
		while (queueIndex < this.scanQueue.length) {
			if (this.projectRoot !== root) return

			const filesToUpdate: { absolutePath: string; relPath: string }[] = []
			let itemsProcessedInBatch = 0

			while (queueIndex < this.scanQueue.length && itemsProcessedInBatch < SymbolIndexService.FILES_PER_BATCH) {
				const { absolutePath, relPath } = this.scanQueue[queueIndex++]!
				itemsProcessedInBatch++

				try {
					const stats = await fs.stat(absolutePath)

					if (stats.isDirectory()) {
						const entries = await fs.readdir(absolutePath, { withFileTypes: true })
						for (const entry of entries) {
							if (this.isExcluded(entry.name)) continue
							const entryAbsPath = path.join(absolutePath, entry.name)
							const entryRelPath = relPath === "" ? entry.name : path.join(relPath, entry.name)
							this.scanQueue.push({ absolutePath: entryAbsPath, relPath: entryRelPath })
						}
					} else if (stats.isFile()) {
						if (this.shouldIndexFile(relPath)) {
							filesChecked++
							const existing = this.db?.getFileMetadata(relPath)
							const mtimeSecs = existing ? Math.floor(existing.mtime / 1000) : 0
							const currentMtimeSecs = Math.floor(stats.mtimeMs / 1000)

							if (!existing || mtimeSecs !== currentMtimeSecs || existing.size !== stats.size) {
								filesToUpdate.push({ absolutePath, relPath })
							}
						}
					}
				} catch (error) {
					Logger.error(`Error scanning path ${absolutePath}:`, error)
				}
			}

			if (filesToUpdate.length > 0) {
				Logger.info(`[SymbolIndexService] Indexing batch of ${filesToUpdate.length} files`)
				try {
					const absolutePaths = filesToUpdate.map((f) => f.absolutePath)
					const languageParsers = await loadRequiredLanguageParsers(absolutePaths)
					const nameCache = new Map<string, string>()

					const results = await Promise.all(
						filesToUpdate.map((file) =>
							limit(async () => {
								if (this.pendingUpdates.has(file.absolutePath)) return null
								try {
									const entry = await this.indexFile(file.absolutePath, languageParsers, nameCache)
									return entry ? { file, entry } : null
								} catch (error) {
									Logger.error(`Error indexing file ${file.absolutePath}:`, error)
									return null
								}
							}),
						),
					)

					const validResults = results.filter((r): r is NonNullable<typeof r> => r !== null)
					if (validResults.length > 0 && this.db) {
						this.db.updateFilesSymbolsBatch(
							validResults.map((r) => ({
								relPath: r.file.relPath,
								mtime: r.entry.mtime,
								size: r.entry.size,
								symbols: r.entry.symbols,
							})),
						)
						const previousIndexed = filesIndexed
						filesIndexed += validResults.length
						if (!this.isFullScanInProgress || Math.floor(previousIndexed / 1000) < Math.floor(filesIndexed / 1000)) {
							this.scheduleSave()
						}
						Logger.info(`[SymbolIndexService] Indexed ${validResults.length} files in this batch`)
					}
				} catch (error) {
					Logger.error("Error during batch indexing:", error)
				}
			}

			await new Promise((resolve) => setImmediate(resolve))
		}
		this.scanQueue = []

		Logger.info(`Symbol index scan complete. Checked ${filesChecked} files, re-indexed ${filesIndexed} files.`)
	}
	private async indexFile(
		absolutePath: string,
		languageParsers: Record<string, { parser: Parser; query: Parser.Query }>,
		nameCache?: Map<string, string>
	): Promise<FileIndexEntry | null> {
		try {
			const stats = await fs.stat(absolutePath)
			if (stats.size > SymbolIndexService.MAX_FILE_SIZE) {
				return null
			}

			const fileContent = await fs.readFile(absolutePath, "utf8")
			const ext = path.extname(absolutePath).toLowerCase().slice(1)
			const { parser, query } = languageParsers[ext] || {}

			if (!parser || !query) return null

			let tree: Parser.Tree | null = null
			try {
				tree = parser.parse(fileContent)
				if (!tree || !tree.rootNode) return null

				const symbols: FileIndexEntry["symbols"] = []
				const captures = query.captures(tree.rootNode)

				for (const capture of captures) {
					const { node, name } = capture
					if (absolutePath.endsWith("src/core/task/index.ts")) {
						const text = fileContent.slice(node.startIndex, node.endIndex)
						if (text === "getEnvironmentDetails" || text === "loadContext") {
							Logger.info(`[SymbolIndexService] Capture for ${text}: ${name}`)
						}
					}
					if (name === "name.reference" || name.includes("name.definition")) {
						let text = fileContent.slice(node.startIndex, node.endIndex)
						if (nameCache) {
							const cached = nameCache.get(text)
							if (cached) {
								text = cached
							} else {
								nameCache.set(text, text)
							}
						}
						symbols.push({
							n: text,
							t: name.includes("name.definition") ? "d" : "r",
							k: name.split(".").pop(),
							r: [node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column],
						})
					}
				}

				return {
					mtime: stats.mtimeMs,
					size: stats.size,
					hash: "",
					symbols,
				}
			} finally {
				if (tree) {
					tree.delete()
				}
			}
		} catch (error) {
			Logger.error(`[SymbolIndexService] Error indexing file ${absolutePath}:`, error)
			return null
		}
	}

		public getSymbols(symbol: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
		return this.db?.getSymbolsByName(symbol, type, limit) || []
	}

	public getReferences(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "reference", limit)
	}

	public getDefinitions(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "definition", limit)
	}

	async updateFile(absolutePath: string): Promise<void> {
		const relPath = path.relative(this.projectRoot, absolutePath)
		if (!this.shouldIndexFile(relPath)) return

		if (this.pendingUpdates.has(absolutePath)) return
		this.pendingUpdates.add(absolutePath)

		try {
			const languageParsers = await loadRequiredLanguageParsers([absolutePath])
			const entry = await this.indexFile(absolutePath, languageParsers)
			if (entry && this.db) {
				this.db.updateFileSymbols(relPath, entry.mtime, entry.size, entry.symbols)
				this.scheduleSave()
			}
		} finally {
			this.pendingUpdates.delete(absolutePath)
		}
	}

	async removeFile(absolutePath: string): Promise<void> {
		const relPath = path.relative(this.projectRoot, absolutePath)
		this.db?.removeFile(relPath)
		this.scheduleSave()
	}

	private scheduleSave(): void {
		if (this.isFullScanInProgress && this.saveTimeout) {
			return // Don't reset timeout during full scan if one is already pending
		}
		if (!this.isPersistenceEnabled) {
			return
		}
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout)
		}
		this.saveTimeout = setTimeout(() => {
			this.saveTimeout = null
			if (this.db) {
				this.db.save()
			}
		}, SymbolIndexService.SAVE_DEBOUNCE_MS)
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
