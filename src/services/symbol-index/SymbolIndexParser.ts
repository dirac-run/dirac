import { loadRequiredLanguageParsers } from "@services/tree-sitter/languageParser"
import * as fs from "fs/promises"
import pLimit from "p-limit"
import * as path from "path"
import Parser from "web-tree-sitter"
import { Logger } from "../../shared/services/Logger"
import { SymbolIndexDatabase } from "./SymbolIndexDatabase"
import type { FileIndexEntry } from "./SymbolIndexService"

// Directories that should never be traversed when scanning for source files
const EXCLUDED_DIRS = new Set([
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

// Lockfiles and generated manifests that carry no useful symbol data
const EXCLUDED_FILES = new Set([
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

// Languages with tree-sitter grammar support for symbol extraction
const SUPPORTED_EXTENSIONS = [
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

const MAX_FILE_SIZE = 1024 * 1024 // 1MB — skip files larger than this to bound parse cost
const FILES_PER_BATCH = 10 // files processed per scan loop iteration before yielding
const PARALLEL_PARSING_LIMIT = 10 // max concurrent tree-sitter parses within a batch

/**
 * Owns tree-sitter parsing and the full-scan driver that walks a project root,
 * parses changed files, and writes extracted symbols into the index database.
 * Stateless across scans except for the per-scan queue/pending-update buffers.
 */
export class SymbolIndexParser {
	private scanQueue: { absolutePath: string; relPath: string }[] = []
	private pendingUpdates: Set<string> = new Set()

	constructor(private readonly indexDir: string) {}

	// A directory entry is excluded if it is a known build/dep dir, the index dir itself, or a hidden dir not part of .dirac
	isExcluded(name: string): boolean {
		if (EXCLUDED_DIRS.has(name)) return true
		if (name === this.indexDir) return true
		if (name.startsWith(".") && !name.startsWith(".dirac")) return true
		return false
	}

	// A file is indexable when no path component is excluded, it is not a lockfile, and its extension is supported
	shouldIndexFile(relPath: string): boolean {
		const parts = relPath.split(path.sep)
		for (const part of parts) {
			if (this.isExcluded(part)) return false
		}

		const fileName = path.basename(relPath)
		if (EXCLUDED_FILES.has(fileName)) return false

		const ext = path.extname(relPath).toLowerCase().slice(1)
		return SUPPORTED_EXTENSIONS.includes(ext)
	}

	// Parse a single file with tree-sitter and return its symbol entries, or null when unsupported/too large/empty
	async indexFile(
		absolutePath: string,
		languageParsers: Record<string, { parser: Parser; query: Parser.Query }>,
		nameCache?: Map<string, string>,
	): Promise<FileIndexEntry | null> {
		try {
			const stats = await fs.stat(absolutePath)
			if (stats.size > MAX_FILE_SIZE) return null

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
					if (name === "name.reference" || name.includes("name.definition")) {
						let text = fileContent.slice(node.startIndex, node.endIndex)
						// Deduplicate identical identifier strings across the scan to shrink stored symbol names
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
				if (tree) tree.delete()
			}
		} catch (error) {
			Logger.error(`[SymbolIndexParser] Error indexing file ${absolutePath}:`, error)
			return null
		}
	}

	// Walk projectRoot breadth-first, batching changed files into parallel tree-sitter parses and db updates.
	// Aborts early when isCancelled returns true (e.g. the service's projectRoot changed mid-scan).
	async runFullScan(projectRoot: string, db: SymbolIndexDatabase | null, isCancelled: () => boolean): Promise<void> {
		Logger.info("[SymbolIndexParser] Starting runFullScan")
		const root = projectRoot
		this.scanQueue = [{ absolutePath: root, relPath: "" }]

		let filesChecked = 0
		let filesIndexed = 0
		const limit = pLimit(PARALLEL_PARSING_LIMIT)

		const nameCache = new Map<string, string>()
		let languageParsers: Record<string, { parser: Parser; query: Parser.Query }> = {}
		let queueIndex = 0
		while (queueIndex < this.scanQueue.length) {
			if (isCancelled()) return

			const filesToUpdate: { absolutePath: string; relPath: string }[] = []
			let itemsProcessedInBatch = 0

			while (queueIndex < this.scanQueue.length && itemsProcessedInBatch < FILES_PER_BATCH) {
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
							const existing = db?.getFileMetadata(relPath)
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
				Logger.info(`[SymbolIndexParser] Indexing batch of ${filesToUpdate.length} files`)
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
					if (validResults.length > 0 && db) {
						db.updateFilesSymbolsBatch(
							validResults.map((r) => ({
								relPath: r.file.relPath,
								mtime: r.entry.mtime,
								size: r.entry.size,
								symbols: r.entry.symbols,
							})),
						)
						filesIndexed += validResults.length
						// better-sqlite3 persists automatically — no explicit save needed
						Logger.info(`[SymbolIndexParser] Indexed ${validResults.length} files in this batch`)
					}
				} catch (error) {
					Logger.error("Error during batch indexing:", error)
				}
			}

			await new Promise((resolve) => setImmediate(resolve))

			// Compact the queue periodically to avoid unbounded growth on huge repos
			if (queueIndex > 1000) {
				this.scanQueue.splice(0, queueIndex)
				queueIndex = 0
			}
		}
		this.scanQueue = []

		Logger.info(`Symbol index scan complete. Checked ${filesChecked} files, re-indexed ${filesIndexed} files.`)
	}

	// Reset per-scan buffers when the indexed root changes
	reset(): void {
		this.scanQueue = []
		this.pendingUpdates.clear()
	}
}
