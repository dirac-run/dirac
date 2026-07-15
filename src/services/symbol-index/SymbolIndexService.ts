import { loadRequiredLanguageParsers } from "@services/tree-sitter/languageParser"
import * as fs from "fs/promises"
import { statSync } from "fs"
import * as path from "path"
import { Parser, Query, Tree } from "web-tree-sitter"
import { Logger } from "../../shared/services/Logger"
import { SymbolIndexDatabase } from "./SymbolIndexDatabase"
import { SymbolIndexTelemetry } from "./SymbolIndexTelemetry"

export interface SymbolLocation {
	path: string
	startLine: number
	startColumn: number
	endLine: number
	endColumn: number
	type: "definition" | "reference"
	kind?: string
}

export interface FileIndexEntry {
	mtime: number
	size: number
	hash: string
	symbols: Array<{
		n: string
		t: "d" | "r"
		k?: string
		r: [number, number, number, number]
	}>
}

export interface PersistentIndex {
	version: number
	files: Record<string, FileIndexEntry>
}

export class SymbolIndexService {
	private static instance: SymbolIndexService | null = null

	private static readonly EXCLUDED_PATH_SEGMENTS = new Set([
		"node_modules",
		"out",
		"dist",
		"dist-standalone",
		"build",
		"coverage",
		"coverage-unit",
		".nyc_output",
		"test-results",
		"tmp",
		".git",
		".dirac-cache",
		".dirac-symbol-index",
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

	private static readonly SUPPORTED_EXTENSIONS = new Set([
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
	])

	private static readonly DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024
	private static readonly MAX_FIRST_LINE_LENGTH = 5000
	private static readonly MAX_AVERAGE_LINE_LENGTH = 2000
	private static readonly FILES_PER_BATCH = 10
	private static readonly INDEX_DIR = ".dirac-cache"
	private static readonly INDEX_FILE = "symbol-index.db"
	private static readonly LEGACY_INDEX_DIR = ".dirac-symbol-index"
	private static readonly LEGACY_INDEX_FILE = "data.db"

	private projectRoot = ""
	private db: SymbolIndexDatabase | null = null
	private saveTimeout: NodeJS.Timeout | null = null
	private isScanningInternal = false
	private isFullScanInProgress = false
	private scanQueue: { absolutePath: string; relPath: string }[] = []
	private isPersistenceEnabled = true
	private skipRepoCheck = false
	private maxFileSizeBytes = SymbolIndexService.DEFAULT_MAX_FILE_SIZE_BYTES
	private fullRescanRequested = false
	private fullScanSequence = 0

	private constructor() { }

	public static getInstance(): SymbolIndexService {
		if (!SymbolIndexService.instance) {
			SymbolIndexService.instance = new SymbolIndexService()
		}
		return SymbolIndexService.instance
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

	public setMaxFileSizeBytes(maxFileSizeBytes: number): void {
		this.maxFileSizeBytes = maxFileSizeBytes
	}

	/** Safe to call at the watcher boundary before a debounce entry is allocated. */
	public shouldIndexPath(absolutePath: string): boolean {
		if (!this.projectRoot) return false
		const relativePath = path.relative(this.projectRoot, absolutePath)
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
			return false
		}
		return this.shouldIndexRelativePath(relativePath)
	}

	public requestFullRescan(): void {
		this.fullRescanRequested = true
		if (!this.isScanningInternal) {
			void this.runRequestedFullRescan()
		}
	}

	public async initialize(projectRoot: string): Promise<void> {
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
			const previousRoot = this.projectRoot
			this.projectRoot = projectRoot
			if (previousRoot !== projectRoot) {
				await this.resetProjectDatabase()
			}
			this.isFullScanInProgress = true
			await this.runFullScan()
		} finally {
			this.isFullScanInProgress = false
			this.isScanningInternal = false
		}

		if (this.fullRescanRequested) {
			void this.runRequestedFullRescan()
		}
	}

	public async updateFile(absolutePath: string): Promise<void> {
		if (!this.shouldIndexPath(absolutePath)) return
		SymbolIndexTelemetry.recordUpdateRun()

		try {
			const relativePath = path.relative(this.projectRoot, absolutePath)
			const languageParsers = await loadRequiredLanguageParsers([absolutePath])
			const entry = await this.indexFile(absolutePath, languageParsers)
			if (entry && this.db) {
				this.db.updateFileSymbols(relativePath, entry.mtime, entry.size, entry.symbols)
			}
		} catch (error) {
			SymbolIndexTelemetry.recordUpdateFailure()
			Logger.debug(`[SymbolIndexService] Error updating file ${absolutePath}:`, error)
		}
	}

	public async removeFile(absolutePath: string): Promise<void> {
		if (!this.projectRoot) return
		const relativePath = path.relative(this.projectRoot, absolutePath)
		if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return
		this.db?.removeFile(relativePath)
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

	public getSymbols(symbol: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
		if (!this.db) return []

		while (true) {
			const locations = this.db.getSymbolsByName(symbol, type, limit)
			const stalePaths = this.findMissingResultPaths(locations)
			if (stalePaths.length === 0) return locations
			this.removeStaleIndexedPaths(stalePaths, "symbol lookup")
		}
	}

	public getReferences(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "reference", limit)
	}

	public getDefinitions(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "definition", limit)
	}

	private findMissingResultPaths(locations: SymbolLocation[]): string[] {
		return this.findMissingPaths(new Set(locations.map((location) => location.path)))
	}

	private findMissingPaths(relativePaths: Iterable<string>): string[] {
		if (!this.projectRoot) return []

		const stalePaths: string[] = []
		for (const relativePath of relativePaths) {
			try {
				const stats = statSync(path.join(this.projectRoot, relativePath))
				if (!stats.isFile()) stalePaths.push(relativePath)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") stalePaths.push(relativePath)
			}
		}
		return stalePaths
	}

	private removeStaleIndexedPaths(relativePaths: Iterable<string>, reason: string): number {
		if (!this.db) return 0

		const paths = [...relativePaths]
		if (paths.length === 0) return 0
		const filesRemoved = this.db.removeFiles(paths)
		if (filesRemoved === 0) return 0

		const sample = paths.slice(0, 10).join(", ")
		const omittedCount = paths.length - 10
		const omittedSuffix = omittedCount > 0 ? `, ... ${omittedCount} more` : ""
		Logger.info(
			`[SymbolIndexService] Removed ${filesRemoved} stale indexed file(s) during ${reason}. Sample: ${sample}${omittedSuffix}`,
		)
		return filesRemoved
	}

	private async runRequestedFullRescan(): Promise<void> {
		if (!this.fullRescanRequested || this.isScanningInternal || !this.projectRoot) return
		this.fullRescanRequested = false
		this.isScanningInternal = true
		this.isFullScanInProgress = true
		try {
			Logger.info("[SymbolIndexService] Starting requested full rescan")
			await this.runFullScan()
		} catch (error) {
			Logger.debug("[SymbolIndexService] Requested full rescan failed:", error)
		} finally {
			this.isFullScanInProgress = false
			this.isScanningInternal = false
		}
		if (this.fullRescanRequested) {
			void this.runRequestedFullRescan()
		}
	}

	private async resetProjectDatabase(): Promise<void> {
		this.scanQueue = []
		if (this.db) {
			this.db.close()
			this.db = null
		}
		if (this.isPersistenceEnabled) {
			await this.ensureIndexDir()
			await this.excludeIndexDirFromGit()
		}
		const databasePath = path.join(this.projectRoot, SymbolIndexService.INDEX_DIR, SymbolIndexService.INDEX_FILE)
		this.db = await SymbolIndexDatabase.create(databasePath)
	}

	private async isRepository(directoryPath: string): Promise<boolean> {
		for (const vcsDirectory of [".git", ".hg", ".svn"]) {
			try {
				await fs.access(path.join(directoryPath, vcsDirectory))
				return true
			} catch {
				continue
			}
		}
		return false
	}

	private async ensureIndexDir(): Promise<void> {
		if (!this.isPersistenceEnabled) return
		const indexDirectory = path.join(this.projectRoot, SymbolIndexService.INDEX_DIR)
		const legacyIndexDirectory = path.join(this.projectRoot, SymbolIndexService.LEGACY_INDEX_DIR)
		const indexDirectoryExists = await this.pathExists(indexDirectory)
		const legacyIndexDirectoryExists = await this.pathExists(legacyIndexDirectory)

		if (legacyIndexDirectoryExists && indexDirectoryExists) {
			await fs.rm(legacyIndexDirectory, { recursive: true, force: true })
		}
		if (legacyIndexDirectoryExists && !indexDirectoryExists) {
			await fs.rename(legacyIndexDirectory, indexDirectory)
		}
		await fs.mkdir(indexDirectory, { recursive: true })
		await this.migrateLegacyIndexFile(indexDirectory)
	}

	private async pathExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath)
			return true
		} catch {
			return false
		}
	}

	private async migrateLegacyIndexFile(indexDirectory: string): Promise<void> {
		const legacyIndexFile = path.join(indexDirectory, SymbolIndexService.LEGACY_INDEX_FILE)
		if (!(await this.pathExists(legacyIndexFile))) return
		const indexFile = path.join(indexDirectory, SymbolIndexService.INDEX_FILE)
		if (await this.pathExists(indexFile)) {
			await fs.rm(legacyIndexFile, { force: true })
			return
		}
		await fs.rename(legacyIndexFile, indexFile)
	}

	private async excludeIndexDirFromGit(): Promise<void> {
		const gitDirectory = path.join(this.projectRoot, ".git")
		try {
			await fs.access(gitDirectory)
		} catch {
			return
		}

		try {
			const excludePath = path.join(gitDirectory, "info", "exclude")
			await fs.mkdir(path.dirname(excludePath), { recursive: true })
			let content = ""
			try {
				content = await fs.readFile(excludePath, "utf8")
			} catch {
				// The exclusion file will be created below.
			}
			const entry = `${SymbolIndexService.INDEX_DIR}/`
			if (!content.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === SymbolIndexService.INDEX_DIR)) {
				await fs.writeFile(
					excludePath,
					content.endsWith("\n") || !content ? `${content}${entry}\n` : `${content}\n${entry}\n`,
				)
			}
		} catch (error) {
			Logger.debug("[SymbolIndexService] Failed to update .git/info/exclude:", error)
		}
	}

	private shouldIndexRelativePath(relativePath: string): boolean {
		const normalizedPath = path.normalize(relativePath)
		const pathSegments = normalizedPath.split(path.sep)
		if (pathSegments.some((segment) => SymbolIndexService.EXCLUDED_PATH_SEGMENTS.has(segment))) return false

		const fileName = path.basename(normalizedPath)
		if (SymbolIndexService.EXCLUDED_FILES.has(fileName)) return false

		const extension = path.extname(normalizedPath).toLowerCase().slice(1)
		return SymbolIndexService.SUPPORTED_EXTENSIONS.has(extension)
	}

	private async runFullScan(): Promise<void> {
		const root = this.projectRoot
		const scanId = ++this.fullScanSequence
		const startedAt = Date.now()
		Logger.info(`[SymbolIndexService] Starting full scan id=${scanId}`)
		const stalePaths = this.db ? new Set(this.db.getAllFilesMetadata().keys()) : new Set<string>()
		this.scanQueue = [{ absolutePath: root, relPath: "" }]
		let filesChecked = 0
		let filesIndexed = 0
		let languageParsers: Record<string, { parser: Parser; query: Query }> = {}
		let queueIndex = 0

		while (queueIndex < this.scanQueue.length) {
			if (this.projectRoot !== root) return
			const filesToUpdate: { absolutePath: string; relPath: string }[] = []
			let itemsProcessed = 0

			while (queueIndex < this.scanQueue.length && itemsProcessed < SymbolIndexService.FILES_PER_BATCH) {
				const { absolutePath, relPath } = this.scanQueue[queueIndex++]!
				itemsProcessed++
				try {
					const stats = await fs.stat(absolutePath)
					if (stats.isDirectory()) {
						for (const entry of await fs.readdir(absolutePath, {
							withFileTypes: true,
						})) {
							if (SymbolIndexService.EXCLUDED_PATH_SEGMENTS.has(entry.name)) continue
							this.scanQueue.push({
								absolutePath: path.join(absolutePath, entry.name),
								relPath: relPath ? path.join(relPath, entry.name) : entry.name,
							})
						}
						continue
					}
					if (!stats.isFile() || !this.shouldIndexRelativePath(relPath)) continue
					stalePaths.delete(relPath)

					filesChecked++
					const existing = this.db?.getFileMetadata(relPath)
					if (
						!existing ||
						Math.floor(existing.mtime / 1000) !== Math.floor(stats.mtimeMs / 1000) ||
						existing.size !== stats.size
					) {
						filesToUpdate.push({ absolutePath, relPath })
					}
				} catch (error) {
					Logger.debug(`[SymbolIndexService] Error scanning path ${absolutePath}:`, error)
				}
			}

			if (filesToUpdate.length > 0) {
				const pathsToLoad = filesToUpdate
					.filter((file) => !(path.extname(file.absolutePath).toLowerCase().slice(1) in languageParsers))
					.map((file) => file.absolutePath)
				if (pathsToLoad.length > 0) {
					languageParsers = {
						...languageParsers,
						...(await loadRequiredLanguageParsers(pathsToLoad)),
					}
				}

				const entries: Array<{ relPath: string; entry: FileIndexEntry }> = []
				// Shared parsers are reused; full-scan parsing stays strictly sequential.
				for (const file of filesToUpdate) {
					try {
						const entry = await this.indexFile(file.absolutePath, languageParsers)
						if (entry) entries.push({ relPath: file.relPath, entry })
					} catch (error) {
						Logger.debug(`[SymbolIndexService] Error indexing file ${file.absolutePath}:`, error)
					}
				}
				if (entries.length > 0 && this.db) {
					this.db.updateFilesSymbolsBatch(
						entries.map(({ relPath, entry }) => ({
							relPath,
							mtime: entry.mtime,
							size: entry.size,
							symbols: entry.symbols,
						})),
					)
					filesIndexed += entries.length
				}
			}

			await new Promise((resolve) => setImmediate(resolve))
			if (queueIndex > 1000) {
				this.scanQueue.splice(0, queueIndex)
				queueIndex = 0
			}
		}

		this.scanQueue = []
		const filesRemoved = this.removeStaleIndexedPaths(this.findMissingPaths(stalePaths), "full scan")
		Logger.info(
			`[SymbolIndexService] Completed full scan id=${scanId} elapsedMs=${Date.now() - startedAt} checked=${filesChecked} indexed=${filesIndexed} removed=${filesRemoved}`,
		)
	}

	private async indexFile(
		absolutePath: string,
		languageParsers: Record<string, { parser: Parser; query: Query }>,
	): Promise<FileIndexEntry | null> {
		const stats = await fs.stat(absolutePath)
		if (stats.size > this.maxFileSizeBytes) {
			SymbolIndexTelemetry.recordSizeSkip()
			return null
		}

		const fileContent = await fs.readFile(absolutePath, "utf8")
		if (this.isLikelyMinifiedOrGenerated(fileContent)) {
			SymbolIndexTelemetry.recordMinifiedSkip()
			return null
		}

		const extension = path.extname(absolutePath).toLowerCase().slice(1)
		const { parser, query } = languageParsers[extension] || {}
		if (!parser || !query) return null

		let tree: Tree | null = null
		try {
			tree = parser.parse(fileContent)
			if (!tree?.rootNode) return null
			const symbols: FileIndexEntry["symbols"] = []
			for (const capture of query.captures(tree.rootNode)) {
				const { node, name } = capture
				if (name !== "name.reference" && !name.includes("name.definition")) continue
				symbols.push({
					n: fileContent.slice(node.startIndex, node.endIndex),
					t: name.includes("name.definition") ? "d" : "r",
					k: name.split(".").pop(),
					r: [node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column],
				})
			}
			return { mtime: stats.mtimeMs, size: stats.size, hash: "", symbols }
		} finally {
			tree?.delete()
		}
	}

	private isLikelyMinifiedOrGenerated(fileContent: string): boolean {
		const lines = fileContent.split(/\r?\n/)
		if (lines[0]?.length > SymbolIndexService.MAX_FIRST_LINE_LENGTH) return true
		const totalLength = lines.reduce((total, line) => total + line.length, 0)
		return totalLength / Math.max(lines.length, 1) > SymbolIndexService.MAX_AVERAGE_LINE_LENGTH
	}
}
