import type {
	GlobalState,
	GlobalStateAndSettings,
	GlobalStateAndSettingsKey,
	LocalState,
	LocalStateKey,
	SecretKey,
	Secrets,
	SettingsKey,
} from "@shared/storage/state-keys"
import type { StorageContext } from "@shared/storage/storage-context"
import type { RunHistoryItem } from "@shared/HistoryItem"
import chokidar, { type FSWatcher } from "chokidar"
import { Logger } from "@/shared/services/Logger"
import { ChokidarWatcherCloser } from "@/shared/utils/ChokidarWatcherCloser"
import {
	getTaskHistoryStateFilePath,
	readTaskHistoryFromState,
	readTaskSettingsFromStorage,
	taskHistoryStateFileExists,
	writeTaskSettingsToStorage,
} from "./disk"
import {
	applyTaskHistoryMutations,
	commitTaskHistoryMutations,
	type TaskHistoryMutation,
} from "./taskHistory"
import { readGlobalStateFromStorage, readSecretsFromStorage, readWorkspaceStateFromStorage } from "./utils/state-helpers"

export interface PersistenceErrorEvent {
	error: Error
}

// Cache accessors — let the persistence manager read cache values without owning the caches
interface CacheAccessors {
	getGlobalStateValue: (key: GlobalStateAndSettingsKey) => any
	getTaskStateValue: (key: SettingsKey) => any
	getSecretValue: (key: SecretKey) => any
	getWorkspaceStateValue: (key: LocalStateKey) => any
	setTaskHistoryInCache: (value: RunHistoryItem[]) => void
	onTaskHistoryCommitMerged: () => void
}

/**
 * Handles all disk persistence for StateManager: debounced writes, batch flushes,
 * task-history file watching, and initial disk reads.
 * StateManager owns the in-memory caches; this class owns the pending-write queues
 * and the actual file I/O.
 */
export class StatePersistenceManager {
	private storage: StorageContext
	private accessors: CacheAccessors

	private pendingGlobalState = new Set<GlobalStateAndSettingsKey>()
	private pendingTaskState = new Map<string, Set<SettingsKey>>()
	private pendingSecrets = new Set<SecretKey>()
	private pendingWorkspaceState = new Set<LocalStateKey>()
	private pendingTaskHistoryMutations: TaskHistoryMutation[] = []
	private inFlightTaskHistoryMutations: TaskHistoryMutation[] = []
	private persistenceTimeout: NodeJS.Timeout | null = null
	private persistenceTail: Promise<void> = Promise.resolve()
	private readonly PERSISTENCE_DELAY_MS = 500
	private taskHistoryWatcher: FSWatcher | null = null
	private readonly taskHistoryWatcherCloser = new ChokidarWatcherCloser()

	onPersistenceError?: (event: PersistenceErrorEvent) => void

	constructor(storage: StorageContext, accessors: CacheAccessors) {
		this.storage = storage
		this.accessors = accessors
	}

	// ── Pending-state tracking ──────────────────────────────────────────

	addPendingGlobalState(key: GlobalStateAndSettingsKey): void {
		if (key === "taskHistory") throw new Error("Task history requires an ID-scoped mutation")
		this.pendingGlobalState.add(key)
		this.scheduleDebouncedPersistence()
	}

	addPendingGlobalStateBatch(keys: GlobalStateAndSettingsKey[]): void {
		if (keys.includes("taskHistory")) throw new Error("Task history requires an ID-scoped mutation")
		keys.forEach((key) => this.pendingGlobalState.add(key))
		this.scheduleDebouncedPersistence()
	}

	addPendingTaskState(taskId: string, key: SettingsKey): void {
		if (!this.pendingTaskState.has(taskId)) {
			this.pendingTaskState.set(taskId, new Set())
		}
		this.pendingTaskState.get(taskId)?.add(key)
		this.scheduleDebouncedPersistence()
	}

	addPendingTaskStateBatch(taskId: string, keys: SettingsKey[]): void {
		if (!this.pendingTaskState.has(taskId)) {
			this.pendingTaskState.set(taskId, new Set())
		}
		keys.forEach((key) => this.pendingTaskState.get(taskId)?.add(key))
		this.scheduleDebouncedPersistence()
	}

	addPendingSecret(key: SecretKey): void {
		this.pendingSecrets.add(key)
		this.scheduleDebouncedPersistence()
	}

	addPendingSecretBatch(keys: SecretKey[]): void {
		keys.forEach((key) => this.pendingSecrets.add(key))
		this.scheduleDebouncedPersistence()
	}

	addPendingWorkspaceState(key: LocalStateKey): void {
		this.pendingWorkspaceState.add(key)
		this.scheduleDebouncedPersistence()
	}

	addPendingWorkspaceStateBatch(keys: LocalStateKey[]): void {
		keys.forEach((key) => this.pendingWorkspaceState.add(key))
		this.scheduleDebouncedPersistence()
	}

	addPendingTaskHistoryMutation(mutation: TaskHistoryMutation): void {
		this.pendingTaskHistoryMutations.push(structuredClone(mutation))
		this.scheduleDebouncedPersistence()
	}

	// ── Task-state queries ──────────────────────────────────────────────

	hasPendingTaskState(): boolean {
		return this.pendingTaskState.size > 0
	}

	async persistAndClearPendingTaskState(): Promise<void> {
		try {
			await this.persistTaskStateBatch(this.pendingTaskState)
			this.pendingTaskState.clear()
		} catch (error) {
			Logger.error("[StatePersistenceManager] Failed to persist task settings before clearing:", error)
		}
	}

	clearPendingTaskState(): void {
		this.pendingTaskState.clear()
	}

	// ── Flush / persist ─────────────────────────────────────────────────

	async persistPendingState(): Promise<void> {
		const operation = this.persistenceTail.then(() => this.persistNextBatch())
		this.persistenceTail = operation.catch(() => undefined)
		return operation
	}

	private async persistNextBatch(): Promise<void> {
		// Early return if nothing to persist
		if (
			this.pendingGlobalState.size === 0 &&
			this.pendingSecrets.size === 0 &&
			this.pendingWorkspaceState.size === 0 &&
			this.pendingTaskState.size === 0 &&
			this.pendingTaskHistoryMutations.length === 0
		) {
			return
		}

		const pendingGlobalState = this.pendingGlobalState
		const pendingSecrets = this.pendingSecrets
		const pendingWorkspaceState = this.pendingWorkspaceState
		const pendingTaskState = this.pendingTaskState
		const pendingTaskHistoryMutations = this.pendingTaskHistoryMutations
		this.pendingGlobalState = new Set()
		this.pendingSecrets = new Set()
		this.pendingWorkspaceState = new Set()
		this.pendingTaskState = new Map()
		this.pendingTaskHistoryMutations = []
		this.inFlightTaskHistoryMutations = pendingTaskHistoryMutations

		try {
			const [regularResult, taskHistoryResult] = await Promise.allSettled([
				Promise.all([
					this.persistGlobalStateBatch(pendingGlobalState),
					this.persistSecretsBatch(pendingSecrets),
					this.persistWorkspaceStateBatch(pendingWorkspaceState),
					this.persistTaskStateBatch(pendingTaskState),
				]),
				this.persistTaskHistoryBatch(pendingTaskHistoryMutations),
			])
			if (regularResult.status === "rejected") {
				for (const key of pendingGlobalState) this.pendingGlobalState.add(key)
				for (const key of pendingSecrets) this.pendingSecrets.add(key)
				for (const key of pendingWorkspaceState) this.pendingWorkspaceState.add(key)
				for (const [taskId, keys] of pendingTaskState) {
					const queuedKeys = this.pendingTaskState.get(taskId) ?? new Set<SettingsKey>()
					for (const key of keys) queuedKeys.add(key)
					this.pendingTaskState.set(taskId, queuedKeys)
				}
			}
			if (taskHistoryResult.status === "rejected") {
				this.pendingTaskHistoryMutations = [
					...pendingTaskHistoryMutations,
					...this.pendingTaskHistoryMutations,
				]
			}
			if (regularResult.status === "rejected") throw regularResult.reason
			if (taskHistoryResult.status === "rejected") throw taskHistoryResult.reason
		} finally {
			this.inFlightTaskHistoryMutations = []
		}
	}

	async flushPendingState(): Promise<void> {
		if (this.persistenceTimeout) {
			clearTimeout(this.persistenceTimeout)
			this.persistenceTimeout = null
		}
		await this.persistPendingState()
	}

	// Dispose watcher and pending timers — called by StateManager.dispose()
	async dispose(): Promise<void> {
		if (this.persistenceTimeout) {
			clearTimeout(this.persistenceTimeout)
			this.persistenceTimeout = null
		}
		const watcher = this.taskHistoryWatcher
		this.taskHistoryWatcher = null
		await this.taskHistoryWatcherCloser.closeAll(watcher ? [watcher] : [])
	}

	// ── Debounced scheduling ────────────────────────────────────────────

	private scheduleDebouncedPersistence(): void {
		if (this.persistenceTimeout) {
			clearTimeout(this.persistenceTimeout)
		}
		this.persistenceTimeout = setTimeout(async () => {
			this.persistenceTimeout = null
			try {
				await this.persistPendingState()
			} catch (error) {
				Logger.error("[StatePersistenceManager] Failed to persist pending changes:", error)
				this.onPersistenceError?.({ error: error })
			}
		}, this.PERSISTENCE_DELAY_MS)
	}

	// ── Batch persist implementations ───────────────────────────────────

	private async persistGlobalStateBatch(keys: Set<GlobalStateAndSettingsKey>): Promise<void> {
		const regularEntries: Record<string, any> = {}
		for (const key of keys) {
			regularEntries[key] = this.accessors.getGlobalStateValue(key)
		}
		if (Object.keys(regularEntries).length > 0) {
			this.storage.globalStateBackingStore.setBatch(regularEntries)
		}
	}

	private async persistTaskHistoryBatch(mutations: TaskHistoryMutation[]): Promise<void> {
		if (mutations.length === 0) return
		const committed = await commitTaskHistoryMutations(mutations)
		const visible = applyTaskHistoryMutations(committed, this.pendingTaskHistoryMutations)
		const cached = this.accessors.getGlobalStateValue("taskHistory")
		this.accessors.setTaskHistoryInCache(visible)
		if (JSON.stringify(visible) !== JSON.stringify(cached)) this.accessors.onTaskHistoryCommitMerged()
	}

	private async persistTaskStateBatch(pendingTaskStates: Map<string, Set<SettingsKey>>): Promise<void> {
		if (pendingTaskStates.size === 0) return
		await Promise.all(
			Array.from(pendingTaskStates.entries()).map(([taskId, keys]) => {
				if (keys.size === 0) return Promise.resolve()
				const settingsToWrite: Record<string, any> = {}
				for (const key of keys) {
					const value = this.accessors.getTaskStateValue(key)
					if (value !== undefined) {
						settingsToWrite[key] = value
					}
				}
				return writeTaskSettingsToStorage(taskId, settingsToWrite)
			}),
		)
	}

	private async persistSecretsBatch(keys: Set<SecretKey>): Promise<void> {
		const entries: Record<string, string | undefined> = {}
		for (const key of keys) {
			const value = this.accessors.getSecretValue(key)
			entries[key] = value || undefined // Convert empty strings to undefined (delete)
		}
		this.storage.secrets.setBatch(entries)
	}

	private async persistWorkspaceStateBatch(keys: Set<LocalStateKey>): Promise<void> {
		const entries: Record<string, any> = {}
		for (const key of keys) {
			entries[key] = this.accessors.getWorkspaceStateValue(key)
		}
		this.storage.workspaceState.setBatch(entries)
	}

	// ── Disk reads ──────────────────────────────────────────────────────

	readGlobalStateKeyFromDisk<K extends GlobalStateAndSettingsKey>(key: K): GlobalStateAndSettings[K] | undefined {
		this.storage.globalStateBackingStore.reloadFromDisk()
		return this.storage.globalStateBackingStore.get(key)
	}

	async readAllFromDisk(): Promise<{ globalState: GlobalStateAndSettings; secrets: Secrets; workspaceState: LocalState }> {
		const globalState = await readGlobalStateFromStorage(this.storage.globalState)
		const secrets = readSecretsFromStorage(this.storage.secrets)
		const workspaceState = readWorkspaceStateFromStorage(this.storage.workspaceState)
		return { globalState, secrets, workspaceState }
	}

	async loadTaskSettingsFromDisk(taskId: string): Promise<Partial<GlobalState>> {
		try {
			return await readTaskSettingsFromStorage(taskId)
		} catch (error) {
			Logger.error(
				"[StatePersistenceManager] Failed to load task settings, defaulting to globally selected settings.",
				error,
			)
			return {}
		}
	}

	async setupTaskHistoryWatcher(isInitialized: () => boolean, onSyncExternalChange: () => void | Promise<void>): Promise<void> {
		try {
			await this.taskHistoryWatcherCloser.closeAll()
			const historyFile = await getTaskHistoryStateFilePath()

			if (this.taskHistoryWatcher) {
				const previousWatcher = this.taskHistoryWatcher
				this.taskHistoryWatcher = null
				await this.taskHistoryWatcherCloser.close(previousWatcher)
			}

			const watcher = chokidar.watch(historyFile, {
				persistent: true,
				ignoreInitial: true,
				atomic: true,
				awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
			})
			this.taskHistoryWatcher = watcher

			const syncTaskHistoryFromDisk = async () => {
				try {
					if (!isInitialized()) return
					if (!(await taskHistoryStateFileExists())) return
					const onDisk = await readTaskHistoryFromState()
					const visible = applyTaskHistoryMutations(onDisk, [
						...this.inFlightTaskHistoryMutations,
						...this.pendingTaskHistoryMutations,
					])
					const cached = this.accessors.getGlobalStateValue("taskHistory")
					if (JSON.stringify(visible) !== JSON.stringify(cached)) {
						this.accessors.setTaskHistoryInCache(visible)
						await onSyncExternalChange()
					}
				} catch (err) {
					Logger.error("[StatePersistenceManager] Failed to reload task history on change:", err)
				}
			}

			watcher
				.on("error", (error) => {
					if (this.taskHistoryWatcher !== watcher) return
					this.taskHistoryWatcher = null
					Logger.error("[StatePersistenceManager] Task history live reload is disabled after watcher failure:", error)
					void this.taskHistoryWatcherCloser
						.close(watcher)
						.catch((closeError) =>
							Logger.error("[StatePersistenceManager] Failed to close disabled task history watcher:", closeError),
						)
				})
				.on("add", () => {
					if (this.taskHistoryWatcher !== watcher) return
					void syncTaskHistoryFromDisk()
				})
				.on("change", () => {
					if (this.taskHistoryWatcher !== watcher) return
					void syncTaskHistoryFromDisk()
				})
				.on("unlink", () => {
					if (this.taskHistoryWatcher !== watcher) return
					Logger.warn("[StatePersistenceManager] Task history file was removed; retaining the last valid cache")
					setTimeout(() => void syncTaskHistoryFromDisk(), 250)
				})
		} catch (err) {
			const watcher = this.taskHistoryWatcher
			this.taskHistoryWatcher = null
			if (watcher) {
				await this.taskHistoryWatcherCloser
					.close(watcher)
					.catch((closeError) =>
						Logger.error("[StatePersistenceManager] Failed to close incomplete task history watcher:", closeError),
					)
			}
			Logger.error("[StatePersistenceManager] Task history live reload could not start and is disabled:", err)
		}
	}
}
