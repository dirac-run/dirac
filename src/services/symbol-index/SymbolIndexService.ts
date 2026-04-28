import { loadRequiredLanguageParsers } from "@services/tree-sitter/languageParser"
import * as fs from "fs/promises"
import ignore from "ignore"
import pLimit from "p-limit"
import * as path from "path"
import Parser from "web-tree-sitter"
import { Logger } from "../../shared/services/Logger"
import { SymbolIndexDatabase } from "./SymbolIndexDatabase"

function getPositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name]
	if (!raw) return fallback

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function toIgnorePath(relPath: string): string {
	return relPath.split(/[\\/]/).join("/")
}

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
	private static readonly MAX_FILES_PER_SCAN = getPositiveIntegerEnv("DIRAC_SYMBOL_INDEX_MAX_FILES", 20_000)
	private static readonly MAX_SCAN_QUEUE_LENGTH = getPositiveIntegerEnv("DIRAC_SYMBOL_INDEX_MAX_SCAN_QUEUE", 100_000)
	private static readonly MAX_SYMBOLS_PER_FILE = getPositiveIntegerEnv("DIRAC_SYMBOL_INDEX_MAX_SYMBOLS_PER_FILE", 2_000)
	private static readonly MAX_REFERENCES_PER_FILE = getPositiveIntegerEnv("DIRAC_SYMBOL_INDEX_MAX_REFERENCES_PER_FILE", 1_000)
	private static readonly VERSION = 1

	private projectRoot = ""
	private db: SymbolIndexDatabase | null = null
	private saveTimeout: NodeJS.Timeout | null = null
	private isScanningInternal = false
	private isFullScanInProgress = false
	private scanQueue: { absolutePath: string; relPath: string }[] = []
	private isPersistenceEnabled = true
	private skipRepoCheck = false
	private pendingUpdates: Set<string> = new Set()
	private ignoreMatcher: ReturnType<typeof ignore> | null = null

	private constructor() {}

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
		if (!enabled) {
			this.clearSaveTimer()
		}
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
			this.ignoreMatcher = await this.loadIgnoreMatcher(projectRoot)

			if (oldRoot !== projectRoot) {
				Logger.info(`[SymbolIndexService] Root changed from ${oldRoot} to ${projectRoot}`)
				this.scanQueue = []
				this.pendingUpdates.clear()
				this.clearSaveTimer()
				this.closeDatabase("root change")

				if (this.isPersistenceEnabled) {
					await this.ensureIndexDir()
					await this.excludeIndexDirFromGit()
				}
				const dbPath = this.isPersistenceEnabled
					? path.join(this.projectRoot, SymbolIndexService.INDEX_DIR, SymbolIndexService.INDEX_FILE)
					: null
				Logger.info(`[SymbolIndexService] Creating database instance${dbPath ? ` at ${dbPath}` : " in memory"}`)
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

	private clearSaveTimer(): void {
		if (!this.saveTimeout) return
		clearTimeout(this.saveTimeout)
		this.saveTimeout = null
	}

	private closeDatabase(reason: string): void {
		if (!this.db) return
		const db = this.db
		this.db = null
		try {
			Logger.info(`[SymbolIndexService] Closing database (${reason})`)
			db.close(this.isPersistenceEnabled)
		} catch (error) {
			Logger.error(`[SymbolIndexService] Failed to close database during ${reason}:`, error)
		}
	}

	private async loadIgnoreMatcher(projectRoot: string): Promise<ReturnType<typeof ignore> | null> {
		const matcher = ignore()
		let hasPatterns = false

		for (const fileName of [".gitignore", ".diracignore"]) {
			const ignorePath = path.join(projectRoot, fileName)
			try {
				const content = await fs.readFile(ignorePath, "utf8")
				if (content.trim()) {
					matcher.add(content)
					hasPatterns = true
				}
			} catch {
				// Ignore files are optional.
			}
		}

		return hasPatterns ? matcher : null
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
				const newContent =
					content.endsWith("\n") || content === "" ? content + entry + "\n" : content + "\n" + entry + "\n"
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

	private isIgnoredRelPath(relPath: string, isDirectory = false): boolean {
		if (!this.ignoreMatcher || !relPath) return false
		const ignorePath = toIgnorePath(relPath)
		return this.ignoreMatcher.ignores(ignorePath) || (isDirectory && this.ignoreMatcher.ignores(`${ignorePath}/`))
	}

	private isRelPathInsideProject(relPath: string): boolean {
		return relPath !== "" && !relPath.startsWith("..") && !path.isAbsolute(relPath)
	}

	private shouldIndexFile(relPath: string): boolean {
		if (!this.isRelPathInsideProject(relPath)) return false
		if (this.isIgnoredRelPath(relPath)) return false

		const parts = relPath.split(/[\\/]/)
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
		let scanLimitReached = false
		const limit = pLimit(SymbolIndexService.PARALLEL_PARSING_LIMIT)

		const nameCache = new Map<string, string>()
		let languageParsers: Record<string, { parser: Parser; query: Parser.Query }> = {}
		let queueIndex = 0
		while (queueIndex < this.scanQueue.length && !scanLimitReached) {
			if (this.projectRoot !== root) return

			const filesToUpdate: { absolutePath: string; relPath: string }[] = []
			let itemsProcessedInBatch = 0

			while (queueIndex < this.scanQueue.length && itemsProcessedInBatch < SymbolIndexService.FILES_PER_BATCH) {
				const { absolutePath, relPath } = this.scanQueue[queueIndex++]!
				itemsProcessedInBatch++

				try {
					const stats = await fs.lstat(absolutePath)
					if (stats.isSymbolicLink()) {
						continue
					}

					if (stats.isDirectory()) {
						if (relPath && this.isIgnoredRelPath(relPath, true)) continue
						const entries = await fs.readdir(absolutePath, { withFileTypes: true })
						for (const entry of entries) {
							if (this.isExcluded(entry.name)) continue
							if (entry.isSymbolicLink()) continue
							const entryAbsPath = path.join(absolutePath, entry.name)
							const entryRelPath = relPath === "" ? entry.name : path.join(relPath, entry.name)
							if (this.isIgnoredRelPath(entryRelPath, entry.isDirectory())) continue
							if (this.scanQueue.length >= SymbolIndexService.MAX_SCAN_QUEUE_LENGTH) {
								Logger.error(
									`[SymbolIndexService] Scan queue reached ${SymbolIndexService.MAX_SCAN_QUEUE_LENGTH}; stopping traversal to prevent runaway indexing.`,
								)
								scanLimitReached = true
								break
							}
							this.scanQueue.push({ absolutePath: entryAbsPath, relPath: entryRelPath })
						}
					} else if (stats.isFile()) {
						if (this.shouldIndexFile(relPath)) {
							if (filesChecked >= SymbolIndexService.MAX_FILES_PER_SCAN) {
								Logger.error(
									`[SymbolIndexService] Reached ${SymbolIndexService.MAX_FILES_PER_SCAN} indexable files; stopping scan to prevent oversized idle background index.`,
								)
								scanLimitReached = true
								break
							}
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
					const newExtensions = absolutePaths
						.map((p) => path.extname(p).toLowerCase().slice(1))
						.filter((ext) => ext && !(ext in languageParsers))
					if (newExtensions.length > 0) {
						const newParsers = await loadRequiredLanguageParsers(
							absolutePaths.filter((p) => {
								const ext = path.extname(p).toLowerCase().slice(1)
								return ext && !(ext in languageParsers)
							}),
						)
						languageParsers = { ...languageParsers, ...newParsers }
					}

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

			if (queueIndex > 1000) {
				this.scanQueue.splice(0, queueIndex)
				queueIndex = 0
			}
		}
		this.scanQueue = []

		Logger.info(`Symbol index scan complete. Checked ${filesChecked} files, re-indexed ${filesIndexed} files.`)
	}
	private async indexFile(
		absolutePath: string,
		languageParsers: Record<string, { parser: Parser; query: Parser.Query }>,
		nameCache?: Map<string, string>,
	): Promise<FileIndexEntry | null> {
		try {
			const stats = await fs.lstat(absolutePath)
			if (stats.isSymbolicLink()) {
				return null
			}
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
				let referenceCount = 0
				const captures = query.captures(tree.rootNode)

				for (const capture of captures) {
					const { node, name } = capture
					if (name === "name.reference" || name.includes("name.definition")) {
						if (symbols.length >= SymbolIndexService.MAX_SYMBOLS_PER_FILE) break
						const isReference = name === "name.reference"
						if (isReference && referenceCount >= SymbolIndexService.MAX_REFERENCES_PER_FILE) continue
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
							t: isReference ? "r" : "d",
							k: name.split(".").pop(),
							r: [node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column],
						})
						if (isReference) referenceCount++
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
		} catch (error) {
			Logger.error(`[SymbolIndexService] Failed to update symbol index for ${absolutePath}:`, error)
		} finally {
			this.pendingUpdates.delete(absolutePath)
		}
	}

	async removeFile(absolutePath: string): Promise<void> {
		const relPath = path.relative(this.projectRoot, absolutePath)
		if (!this.isRelPathInsideProject(relPath)) return
		try {
			this.db?.removeFile(relPath)
			this.scheduleSave()
		} catch (error) {
			Logger.error(`[SymbolIndexService] Failed to remove ${absolutePath} from symbol index:`, error)
		}
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
			try {
				if (this.db) {
					const saved = this.db.save()
					if (!saved) {
						Logger.error(
							"[SymbolIndexService] Disabling symbol-index persistence after save failure; in-memory lookup remains available for this session.",
						)
						this.isPersistenceEnabled = false
					}
				}
			} catch (error) {
				Logger.error("[SymbolIndexService] Unhandled symbol-index save failure; disabling persistence:", error)
				this.isPersistenceEnabled = false
			}
		}, SymbolIndexService.SAVE_DEBOUNCE_MS)
		this.saveTimeout.unref?.()
	}

	public dispose(): void {
		this.clearSaveTimer()
		this.closeDatabase("dispose")
	}
}
