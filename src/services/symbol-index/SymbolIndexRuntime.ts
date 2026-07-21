import * as path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import { Logger } from "../../shared/services/Logger"
import { SymbolIndexTelemetry } from "./SymbolIndexTelemetry"

export type SymbolIndexWatcherEventKind = "upsert" | "remove"

export interface SymbolIndexWatcherEvent {
	absolutePath: string
	kind: SymbolIndexWatcherEventKind
}

export interface SymbolIndexRuntimeDependencies {
	admitsPath(absolutePath: string): boolean
	applyWatcherEvents(events: readonly SymbolIndexWatcherEvent[]): Promise<void>
	requestReconciliation(reason: string): Promise<void>
}

export class SymbolIndexRuntime {
	private static readonly EVENT_BATCH_DELAY_MS = 1_000
	private static readonly MAX_PENDING_EVENTS = 500
	private static readonly RECONCILIATION_INTERVAL_MS = 5 * 60_000

	private readonly watcher: FSWatcher
	private readonly watchedDirectories = new Set<string>()
	private readonly pendingEvents = new Map<string, SymbolIndexWatcherEventKind>()
	private gitDirectory: string | null = null
	private eventTimer: NodeJS.Timeout | null = null
	private activeFlush: Promise<void> | null = null
	private reconciliationTimer: NodeJS.Timeout | null = null
	private disposed = false

	public constructor(
		private readonly projectRoot: string,
		private readonly dependencies: SymbolIndexRuntimeDependencies,
	) {
		this.watcher = chokidar.watch([], { depth: 0, ignoreInitial: true, persistent: true })
		this.watcher.on("add", (filePath) => this.queueFileEvent(filePath, "upsert"))
		this.watcher.on("change", (filePath) => this.queueFileEvent(filePath, "upsert"))
		this.watcher.on("unlink", (filePath) => this.queueFileEvent(filePath, "remove"))
		this.watcher.on("addDir", (directoryPath) => this.recordDirectoryChange(`directory added: ${directoryPath}`))
		this.watcher.on("unlinkDir", (directoryPath) => this.recordDirectoryChange(`directory removed: ${directoryPath}`))
		this.watcher.on("error", (error) => this.requestFullReconciliation(`watcher error: ${error}`))
		this.watcher.on("raw", (eventName, eventPath, details) => {
			if (`${eventName} ${eventPath} ${JSON.stringify(details)}`.toLowerCase().includes("overflow")) {
				this.requestFullReconciliation("watcher overflow")
			}
		})
		this.schedulePeriodicReconciliation()
	}

	public async refreshWatchedDirectories(relativeDirectories: ReadonlySet<string>, gitDirectory: string | null): Promise<void> {
		if (this.disposed) return
		this.gitDirectory = gitDirectory
		const nextDirectories = this.buildWatchDirectories(relativeDirectories)
		const removedDirectories = [...this.watchedDirectories].filter((directory) => !nextDirectories.has(directory))
		const addedDirectories = [...nextDirectories].filter((directory) => !this.watchedDirectories.has(directory))

		if (removedDirectories.length > 0) await this.watcher.unwatch(removedDirectories)
		if (this.disposed) return
		if (addedDirectories.length > 0) this.watcher.add(addedDirectories)
		this.watchedDirectories.clear()
		for (const directory of nextDirectories) this.watchedDirectories.add(directory)
	}

	public async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		if (this.eventTimer) clearTimeout(this.eventTimer)
		if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer)
		this.eventTimer = null
		this.reconciliationTimer = null
		this.pendingEvents.clear()
		await this.watcher.close()
		await this.activeFlush
	}

	private buildWatchDirectories(relativeDirectories: ReadonlySet<string>): Set<string> {
		const directories = new Set([this.projectRoot])
		for (const relativeDirectory of relativeDirectories) {
			directories.add(path.join(this.projectRoot, relativeDirectory))
		}
		if (this.gitDirectory) {
			directories.add(this.gitDirectory)
			directories.add(path.join(this.gitDirectory, "info"))
		}
		return directories
	}

	private queueFileEvent(absolutePath: string, kind: SymbolIndexWatcherEventKind): void {
		if (this.disposed) return
		SymbolIndexTelemetry.recordWatcherEvent()
		if (this.isReconciliationControlPath(absolutePath)) {
			this.requestFullReconciliation(`eligibility control changed: ${absolutePath}`)
			return
		}
		if (!this.dependencies.admitsPath(absolutePath)) {
			SymbolIndexTelemetry.recordWatcherRejected()
			return
		}
		if (!this.pendingEvents.has(absolutePath) && this.pendingEvents.size >= SymbolIndexRuntime.MAX_PENDING_EVENTS) {
			this.pendingEvents.clear()
			if (this.eventTimer) clearTimeout(this.eventTimer)
			this.eventTimer = null
			this.requestFullReconciliation("watcher event overflow")
			return
		}

		this.pendingEvents.set(absolutePath, kind)
		SymbolIndexTelemetry.recordDirtySetSize(this.pendingEvents.size)
		if (this.eventTimer) clearTimeout(this.eventTimer)
		this.eventTimer = setTimeout(() => void this.flushEvents(), SymbolIndexRuntime.EVENT_BATCH_DELAY_MS)
	}

	private isReconciliationControlPath(absolutePath: string): boolean {
		const relativePath = path.normalize(path.relative(this.projectRoot, absolutePath))
		if (path.basename(relativePath) === ".gitignore") return true
		if (!this.gitDirectory) return false
		const gitRelativePath = path.normalize(path.relative(this.gitDirectory, absolutePath))
		return gitRelativePath === "config" || gitRelativePath === "index" || gitRelativePath === path.join("info", "exclude")
	}

	private flushEvents(): Promise<void> {
		if (this.activeFlush) return this.activeFlush
		this.activeFlush = this.drainEventBatches().finally(() => {
			this.activeFlush = null
		})
		return this.activeFlush
	}

	private async drainEventBatches(): Promise<void> {
		this.eventTimer = null
		while (!this.disposed && this.pendingEvents.size > 0) {
			const events = [...this.pendingEvents].map(([absolutePath, kind]) => ({ absolutePath, kind }))
			this.pendingEvents.clear()
			try {
				await this.dependencies.applyWatcherEvents(events)
			} catch (error) {
				SymbolIndexTelemetry.recordFailure()
				Logger.error("[SymbolIndexRuntime] Watcher batch failed; requesting reconciliation", error)
				await this.requestReconciliationSafely("watcher batch failure")
			}
		}
		if (this.eventTimer) clearTimeout(this.eventTimer)
		this.eventTimer = null
	}

	private requestFullReconciliation(reason: string): void {
		if (this.disposed) return
		void this.requestReconciliationSafely(reason)
	}

	private async requestReconciliationSafely(reason: string): Promise<void> {
		try {
			await this.dependencies.requestReconciliation(reason)
		} catch (error) {
			SymbolIndexTelemetry.recordFailure()
			Logger.error(`[SymbolIndexRuntime] Reconciliation request failed (${reason})`, error)
		}
	}

	private recordDirectoryChange(reason: string): void {
		this.requestFullReconciliation(reason)
	}

	private schedulePeriodicReconciliation(): void {
		const jitter = 0.9 + Math.random() * 0.2
		this.reconciliationTimer = setTimeout(async () => {
			this.reconciliationTimer = null
			if (this.disposed) return
			try {
				await this.requestReconciliationSafely("periodic repair")
			} finally {
				SymbolIndexTelemetry.logSummary("periodic")
				if (!this.disposed) this.schedulePeriodicReconciliation()
			}
		}, SymbolIndexRuntime.RECONCILIATION_INTERVAL_MS * jitter)
		this.reconciliationTimer.unref()
	}
}
