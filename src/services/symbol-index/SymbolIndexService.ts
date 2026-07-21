import { statSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { loadRequiredLanguageParsers } from "@services/tree-sitter/languageParser"
import { type Parser, type Query, type Tree } from "web-tree-sitter"
import { Logger } from "../../shared/services/Logger"
import { type FileSymbolReplacement, SymbolIndexDatabase } from "./SymbolIndexDatabase"
import { SymbolIndexEligibility } from "./SymbolIndexEligibility"
import { SymbolIndexRuntime, type SymbolIndexWatcherEvent } from "./SymbolIndexRuntime"
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

type FileIndexOutcome =
	| { status: "indexed"; entry: FileIndexEntry }
	| { status: "rejected"; reason: string }
	| { status: "retry" }

type LanguageParsers = Record<string, { parser: Parser; query: Query }>
type FileCandidate = { absolutePath: string; relPath: string }

export class SymbolIndexService {
	private static instance: SymbolIndexService | null = null
	private static readonly DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024
	private static readonly MAX_FIRST_LINE_LENGTH = 5000
	private static readonly MAX_AVERAGE_LINE_LENGTH = 2000
	private static readonly INDEX_DIR = ".dirac-cache"
	private static readonly INDEX_FILE = "symbol-index.db"
	private static readonly LEGACY_INDEX_DIR = ".dirac-symbol-index"
	private static readonly LEGACY_INDEX_FILE = "data.db"
	private static readonly MAX_STALE_LOOKUP_PASSES = 10
	private static readonly REMOVAL_BATCH_SIZE = 100
	private static readonly INDEXING_BATCH_SIZE = 10
	private static readonly PROGRESS_LOG_BATCH_INTERVAL = 10
	private static readonly COMPACTION_MIN_RECLAIMABLE_BYTES = 64 * 1024 * 1024
	private static readonly COMPACTION_MIN_FREE_RATIO = 0.25

	private projectRoot = ""
	private db: SymbolIndexDatabase | null = null
	private eligibility: SymbolIndexEligibility | null = null
	private runtime: SymbolIndexRuntime | null = null
	private retryTimeout: NodeJS.Timeout | null = null
	private isScanningInternal = false
	private isPersistenceEnabled = true
	private skipRepoCheck = false
	private maxFileSizeBytes = SymbolIndexService.DEFAULT_MAX_FILE_SIZE_BYTES
	private operationTail: Promise<void> = Promise.resolve()
	private activeReconciliation: Promise<void> | null = null
	private queuedReconciliationReason: string | null = null
	private eligiblePaths = new Set<string>()
	private watchDirectories = new Set<string>()
	private gitDirectory: string | null = null
	private disposed = false

	private constructor() {}

	public static getInstance(): SymbolIndexService {
		if (!SymbolIndexService.instance) SymbolIndexService.instance = new SymbolIndexService()
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

	public shouldIndexPath(absolutePath: string): boolean {
		if (!this.projectRoot) return false
		return (this.eligibility ?? new SymbolIndexEligibility(this.projectRoot)).admitsAbsolutePath(absolutePath)
	}

	public async initialize(projectRoot: string): Promise<void> {
		Logger.info(`[SymbolIndexService] Initializing for root: ${projectRoot}`)
		if (this.projectRoot === projectRoot && this.db) return
		if (!this.skipRepoCheck && !(await this.isRepository(projectRoot))) {
			Logger.info(`[SymbolIndexService] ${projectRoot} is not a repository; symbol indexing is disabled`)
			return
		}

		this.disposed = false
		await this.resetProjectDatabase(projectRoot)
		await this.requestReconciliation("initial")
		if (this.disposed) return

		this.runtime = new SymbolIndexRuntime(projectRoot, {
			admitsPath: (absolutePath) => this.shouldIndexPath(absolutePath),
			applyWatcherEvents: (events) => this.applyWatcherEvents(events),
			requestReconciliation: (reason) => this.requestReconciliation(reason),
		})
		await this.refreshRuntimeWatches()
	}

	public async updateFile(absolutePath: string): Promise<void> {
		await this.applyWatcherEvents([{ absolutePath, kind: "upsert" }])
	}

	public async removeFile(absolutePath: string): Promise<void> {
		await this.applyWatcherEvents([{ absolutePath, kind: "remove" }])
	}

	public requestFullRescan(): void {
		void this.requestReconciliation("requested rescan")
	}

	public requestReconciliation(reason: string): Promise<void> {
		if (!this.db || !this.eligibility || this.disposed) return Promise.resolve()
		if (this.activeReconciliation) {
			this.queuedReconciliationReason = reason
			return this.activeReconciliation
		}

		const reconciliation = this.enqueueOperation(() => this.runReconciliationQueue(reason))
		this.activeReconciliation = reconciliation.finally(() => {
			this.activeReconciliation = null
		})
		return this.activeReconciliation
	}

	public dispose(): void {
		this.disposed = true
		if (this.retryTimeout) clearTimeout(this.retryTimeout)
		this.retryTimeout = null
		if (this.runtime) void this.runtime.dispose()
		this.runtime = null

		this.db?.close()
		this.db = null
		SymbolIndexTelemetry.logSummary("deactivation")
	}

	public getSymbols(symbol: string, type?: "definition" | "reference", limit?: number): SymbolLocation[] {
		if (!this.db) return []
		let locations: SymbolLocation[] = []
		for (let pass = 0; pass < SymbolIndexService.MAX_STALE_LOOKUP_PASSES; pass++) {
			locations = this.db.getSymbolsByName(symbol, type, limit)
			const stalePaths = this.findMissingResultPaths(locations)
			if (stalePaths.length === 0) return locations
			if (this.removeStaleIndexedPaths(stalePaths, "symbol lookup") === 0) return locations
		}
		return locations
	}

	public getReferences(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "reference", limit)
	}

	public getDefinitions(symbol: string, limit?: number): SymbolLocation[] {
		return this.getSymbols(symbol, "definition", limit)
	}

	private async runReconciliationQueue(initialReason: string): Promise<void> {
		let reason: string | null = initialReason
		while (reason) {
			try {
				await this.reconcile(reason)
			} catch (error) {
				SymbolIndexTelemetry.recordFailure()
				Logger.error(`[SymbolIndexService] Reconciliation failed (${reason}); completed batches retained`, error)
			}
			reason = this.queuedReconciliationReason
			this.queuedReconciliationReason = null
		}
	}

	private async reconcile(reason: string): Promise<boolean> {
		const db = this.db
		const eligibility = this.eligibility
		if (!db || !eligibility || this.disposed) return false

		this.isScanningInternal = true
		const startedAt = Date.now()
		try {
			const eligibilityResult = await eligibility.enumerate()
			if (this.disposed || this.db !== db) return false
			const eligiblePaths = eligibilityResult.paths
			const existingMetadata = db.getAllFilesMetadata()
			const ineligiblePaths = [...existingMetadata.keys()].filter((relPath) => !eligiblePaths.has(relPath))
			const candidates: FileCandidate[] = []
			const rejectedPaths: string[] = []

			for (const relPath of eligiblePaths) {
				const absolutePath = path.join(this.projectRoot, relPath)
				try {
					const stats = await fs.stat(absolutePath)
					if (!stats.isFile()) {
						rejectedPaths.push(relPath)
						continue
					}
					const existing = existingMetadata.get(relPath)
					if (
						existing &&
						Math.floor(existing.mtime / 1_000) === Math.floor(stats.mtimeMs / 1_000) &&
						existing.size === stats.size
					)
						continue
					candidates.push({ absolutePath, relPath })
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					rejectedPaths.push(relPath)
				}
			}

			const removalPaths = [...ineligiblePaths, ...rejectedPaths]
			Logger.info(
				`[SymbolIndexService] Reconciliation plan reason=${reason} indexed=${existingMetadata.size} eligible=${eligiblePaths.size} removals=${removalPaths.length} candidates=${candidates.length}`,
			)
			const removedBeforeParsing = await this.applyRemovalBatches(db, removalPaths, reason)
			if (this.disposed || this.db !== db) return removedBeforeParsing > 0
			const candidateResult = await this.applyCandidateBatches(db, candidates, reason)
			if (this.disposed || this.db !== db) return removedBeforeParsing > 0 || candidateResult.changed

			this.eligiblePaths = eligiblePaths
			this.watchDirectories = eligibilityResult.watchDirectories
			this.gitDirectory = eligibilityResult.gitDirectory
			if (candidateResult.retryRequested) this.rescheduleChangedDuringRead()
			await this.refreshRuntimeWatches()
			const removed = removedBeforeParsing + candidateResult.removed
			this.compactDatabaseIfNeeded(db, reason)
			SymbolIndexTelemetry.recordReconciliation(eligiblePaths.size, removed, candidateResult.replaced)
			Logger.info(
				`[SymbolIndexService] Reconciled reason=${reason} elapsedMs=${Date.now() - startedAt} eligible=${eligiblePaths.size} removed=${removed} updated=${candidateResult.replaced}`,
			)
			return removed > 0 || candidateResult.changed
		} finally {
			this.isScanningInternal = false
		}
	}

	private enqueueOperation(operation: () => Promise<void>): Promise<void> {
		const queuedOperation = this.operationTail.then(operation)
		this.operationTail = queuedOperation.catch(() => {})
		return queuedOperation
	}

	private applyWatcherEvents(events: readonly SymbolIndexWatcherEvent[]): Promise<void> {
		if (events.length === 0) return Promise.resolve()
		return this.enqueueOperation(() => this.applyWatcherEventsSerially(events))
	}

	private async applyWatcherEventsSerially(events: readonly SymbolIndexWatcherEvent[]): Promise<void> {
		const db = this.db
		const eligibility = this.eligibility
		if (!db || !eligibility || this.disposed) return
		SymbolIndexTelemetry.recordUpdateRun()

		const eligibilityResult = await eligibility.enumerate()
		if (this.disposed || this.db !== db) return
		const removedPaths: string[] = []
		const candidatePaths: FileCandidate[] = []
		for (const event of events) {
			const relPath = path.normalize(path.relative(this.projectRoot, event.absolutePath))
			if (!eligibility.admitsRelativePath(relPath)) {
				SymbolIndexTelemetry.recordWatcherRejected()
				continue
			}
			if (event.kind === "remove") {
				removedPaths.push(relPath)
				continue
			}
			if (eligibilityResult.paths.has(relPath)) candidatePaths.push({ absolutePath: event.absolutePath, relPath })
			else removedPaths.push(relPath)
		}

		await this.applyRemovalBatches(db, removedPaths, "watcher update")
		if (this.disposed || this.db !== db) return
		const candidateResult = await this.applyCandidateBatches(db, candidatePaths, "watcher update")
		if (this.disposed || this.db !== db) return
		this.eligiblePaths = eligibilityResult.paths
		this.watchDirectories = eligibilityResult.watchDirectories
		this.gitDirectory = eligibilityResult.gitDirectory
		if (candidateResult.retryRequested) this.rescheduleChangedDuringRead()
		await this.refreshRuntimeWatches()
	}

	private compactDatabaseIfNeeded(db: SymbolIndexDatabase, reason: string): void {
		if (this.disposed || this.db !== db) return
		const before = db.getAllocation()
		const freeRatio = before.pageCount === 0 ? 0 : before.freelistCount / before.pageCount
		if (before.reclaimableBytes < SymbolIndexService.COMPACTION_MIN_RECLAIMABLE_BYTES) return
		if (freeRatio < SymbolIndexService.COMPACTION_MIN_FREE_RATIO) return

		Logger.info(
			`[SymbolIndexService] Compacting database reason=${reason} reclaimableBytes=${before.reclaimableBytes} freeRatio=${freeRatio.toFixed(3)}`,
		)
		db.compact()
		const after = db.getAllocation()
		Logger.info(
			`[SymbolIndexService] Compacted database reason=${reason} beforeBytes=${before.databaseBytes} afterBytes=${after.databaseBytes} reclaimedBytes=${before.databaseBytes - after.databaseBytes}`,
		)
	}

	private async applyRemovalBatches(
		db: SymbolIndexDatabase,
		relativePaths: readonly string[],
		reason: string,
	): Promise<number> {
		let removed = 0
		for (let offset = 0; offset < relativePaths.length; offset += SymbolIndexService.REMOVAL_BATCH_SIZE) {
			if (this.disposed || this.db !== db) return removed
			const batch = relativePaths.slice(offset, offset + SymbolIndexService.REMOVAL_BATCH_SIZE)
			removed += db.applyMutation({ removals: batch, replacements: [] }).removed
			const processed = Math.min(offset + batch.length, relativePaths.length)
			const batchNumber = Math.floor(offset / SymbolIndexService.REMOVAL_BATCH_SIZE) + 1
			if (processed === relativePaths.length || batchNumber % SymbolIndexService.PROGRESS_LOG_BATCH_INTERVAL === 0)
				Logger.info(
					`[SymbolIndexService] Removal progress reason=${reason} processed=${processed}/${relativePaths.length} removed=${removed}`,
				)
			await this.yieldAfterMutationBatch()
		}
		return removed
	}

	private async applyCandidateBatches(
		db: SymbolIndexDatabase,
		candidates: readonly FileCandidate[],
		reason: string,
	): Promise<{ changed: boolean; removed: number; replaced: number; retryRequested: boolean }> {
		let changed = false
		let removed = 0
		let replaced = 0
		let retryRequested = false
		for (let offset = 0; offset < candidates.length; offset += SymbolIndexService.INDEXING_BATCH_SIZE) {
			if (this.disposed || this.db !== db) break
			const batch = candidates.slice(offset, offset + SymbolIndexService.INDEXING_BATCH_SIZE)
			const staged = await this.stageFiles(batch)
			if (this.disposed || this.db !== db) break
			const mutation = db.applyMutation({ removals: staged.rejectedPaths, replacements: staged.replacements })
			changed ||= mutation.changed
			removed += mutation.removed
			replaced += mutation.replaced
			retryRequested ||= staged.retryRequested
			const processed = Math.min(offset + batch.length, candidates.length)
			const batchNumber = Math.floor(offset / SymbolIndexService.INDEXING_BATCH_SIZE) + 1
			if (processed === candidates.length || batchNumber % SymbolIndexService.PROGRESS_LOG_BATCH_INTERVAL === 0)
				Logger.info(
					`[SymbolIndexService] Indexing progress reason=${reason} processed=${processed}/${candidates.length} updated=${replaced} removed=${removed}`,
				)
			await this.yieldAfterMutationBatch()
		}
		return { changed, removed, replaced, retryRequested }
	}

	private async yieldAfterMutationBatch(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve))
	}

	private async stageFiles(candidates: readonly FileCandidate[]): Promise<{
		replacements: FileSymbolReplacement[]
		rejectedPaths: string[]
		retryRequested: boolean
	}> {
		if (candidates.length === 0) return { replacements: [], rejectedPaths: [], retryRequested: false }
		const languageParsers = await loadRequiredLanguageParsers(candidates.map((candidate) => candidate.absolutePath))
		const replacements: FileSymbolReplacement[] = []
		const rejectedPaths: string[] = []
		let retryRequested = false

		for (const candidate of candidates) {
			const outcome = await this.indexFile(candidate.absolutePath, languageParsers)
			if (outcome.status === "indexed") replacements.push({ relPath: candidate.relPath, ...outcome.entry })
			else if (outcome.status === "rejected") rejectedPaths.push(candidate.relPath)
			else retryRequested = true
		}
		return { replacements, rejectedPaths, retryRequested }
	}

	private async indexFile(absolutePath: string, languageParsers: LanguageParsers): Promise<FileIndexOutcome> {
		let before
		try {
			before = await fs.stat(absolutePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "rejected", reason: "missing" }
			throw error
		}
		if (!before.isFile()) return { status: "rejected", reason: "not a file" }
		if (before.size > this.maxFileSizeBytes) {
			SymbolIndexTelemetry.recordSizeSkip()
			return { status: "rejected", reason: "oversized" }
		}

		const fileBuffer = await fs.readFile(absolutePath)
		const fileContent = fileBuffer.toString("utf8")
		let rejectionReason: string | null = null
		const symbols: FileIndexEntry["symbols"] = []
		if (this.isLikelyMinifiedOrGenerated(fileContent)) {
			SymbolIndexTelemetry.recordMinifiedSkip()
			rejectionReason = "generated or minified"
		}

		const extension = path.extname(absolutePath).toLowerCase().slice(1)
		const { parser, query } = languageParsers[extension] ?? {}
		if (!rejectionReason && (!parser || !query)) rejectionReason = "unsupported parser"

		let tree: Tree | null = null
		try {
			if (!rejectionReason && parser && query) {
				tree = parser.parse(fileContent)
				if (!tree?.rootNode) rejectionReason = "parse failure"
				else {
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
				}
			}
		} finally {
			tree?.delete()
		}

		let after
		try {
			after = await fs.stat(absolutePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "retry" }
			throw error
		}
		if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) return { status: "retry" }
		if (rejectionReason) return { status: "rejected", reason: rejectionReason }
		return { status: "indexed", entry: { mtime: after.mtimeMs, size: after.size, symbols } }
	}

	private rescheduleChangedDuringRead(): void {
		if (this.retryTimeout || this.disposed) return
		this.retryTimeout = setTimeout(() => {
			this.retryTimeout = null
			void this.requestReconciliation("file changed during indexing")
		}, 250)
		this.retryTimeout.unref()
	}

	private async refreshRuntimeWatches(): Promise<void> {
		if (!this.runtime) return
		try {
			await this.runtime.refreshWatchedDirectories(this.watchDirectories, this.gitDirectory)
		} catch (error) {
			SymbolIndexTelemetry.recordFailure()
			Logger.error("[SymbolIndexService] Failed to refresh symbol-index watch directories", error)
		}
	}

	private isLikelyMinifiedOrGenerated(fileContent: string): boolean {
		const lines = fileContent.split(/\r?\n/)
		if (lines[0]?.length > SymbolIndexService.MAX_FIRST_LINE_LENGTH) return true
		const totalLength = lines.reduce((total, line) => total + line.length, 0)
		return totalLength / Math.max(lines.length, 1) > SymbolIndexService.MAX_AVERAGE_LINE_LENGTH
	}

	private findMissingResultPaths(locations: SymbolLocation[]): string[] {
		if (!this.projectRoot) return []
		const stalePaths: string[] = []
		for (const relativePath of new Set(locations.map((location) => location.path))) {
			try {
				if (!statSync(path.join(this.projectRoot, relativePath)).isFile()) stalePaths.push(relativePath)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") stalePaths.push(relativePath)
			}
		}
		return stalePaths
	}

	private removeStaleIndexedPaths(relativePaths: readonly string[], reason: string): number {
		if (!this.db || relativePaths.length === 0) return 0
		const removed = this.db.removeFiles(relativePaths)
		if (removed > 0) {
			Logger.info(`[SymbolIndexService] Removed ${removed} stale indexed file(s) during ${reason}`)
		}
		return removed
	}

	private async resetProjectDatabase(projectRoot: string): Promise<void> {
		if (this.runtime) await this.runtime.dispose()
		this.runtime = null
		await this.operationTail
		if (this.db) this.db.close()
		this.projectRoot = projectRoot
		this.eligibility = new SymbolIndexEligibility(projectRoot)
		this.eligiblePaths = new Set()
		this.watchDirectories = new Set()
		this.gitDirectory = null

		let databasePath: string | undefined
		if (this.isPersistenceEnabled) {
			await this.ensureIndexDir()
			databasePath = path.join(projectRoot, SymbolIndexService.INDEX_DIR, SymbolIndexService.INDEX_FILE)
		}
		this.db = await SymbolIndexDatabase.create(databasePath)
	}

	private async isRepository(directoryPath: string): Promise<boolean> {
		for (const vcsDirectory of [".git", ".hg", ".svn"]) {
			try {
				await fs.access(path.join(directoryPath, vcsDirectory))
				return true
			} catch {}
		}
		return new SymbolIndexEligibility(directoryPath).isGitWorkspace()
	}

	private async ensureIndexDir(): Promise<void> {
		const indexDirectory = path.join(this.projectRoot, SymbolIndexService.INDEX_DIR)
		const legacyIndexDirectory = path.join(this.projectRoot, SymbolIndexService.LEGACY_INDEX_DIR)
		const indexDirectoryExists = await this.pathExists(indexDirectory)
		const legacyIndexDirectoryExists = await this.pathExists(legacyIndexDirectory)
		if (legacyIndexDirectoryExists && indexDirectoryExists) await fs.rm(legacyIndexDirectory, { recursive: true })
		if (legacyIndexDirectoryExists && !indexDirectoryExists) await fs.rename(legacyIndexDirectory, indexDirectory)
		await fs.mkdir(indexDirectory, { recursive: true })
		await this.migrateLegacyIndexFile(indexDirectory)
	}

	private async migrateLegacyIndexFile(indexDirectory: string): Promise<void> {
		const legacyIndexFile = path.join(indexDirectory, SymbolIndexService.LEGACY_INDEX_FILE)
		if (!(await this.pathExists(legacyIndexFile))) return
		const indexFile = path.join(indexDirectory, SymbolIndexService.INDEX_FILE)
		if (await this.pathExists(indexFile)) await fs.rm(legacyIndexFile)
		else await fs.rename(legacyIndexFile, indexFile)
	}

	private async pathExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath)
			return true
		} catch {
			return false
		}
	}
}
