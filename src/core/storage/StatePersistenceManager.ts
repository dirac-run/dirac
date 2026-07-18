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
import chokidar, { type FSWatcher } from "chokidar"
import { Logger } from "@/shared/services/Logger"
import {
	getTaskHistoryStateFilePath,
	readTaskHistoryFromState,
	readTaskSettingsFromStorage,
	writeTaskHistoryToState,
	writeTaskSettingsToStorage,
} from "./disk"
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
	setTaskHistoryInCache: (value: any) => void
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
	private persistenceTimeout: NodeJS.Timeout | null = null
	private readonly PERSISTENCE_DELAY_MS = 500
	private taskHistoryWatcher: FSWatcher | null = null

	onPersistenceError?: (event: PersistenceErrorEvent) => void

	constructor(storage: StorageContext, accessors: CacheAccessors) {
		this.storage = storage
		this.accessors = accessors
	}

	// ── Pending-state tracking ──────────────────────────────────────────

	addPendingGlobalState(key: GlobalStateAndSettingsKey): void {
		this.pendingGlobalState.add(key)
		this.scheduleDebouncedPersistence()
	}

	addPendingGlobalStateBatch(keys: GlobalStateAndSettingsKey[]): void {
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

	hasPendingTimeout(): boolean {
		return this.persistenceTimeout !== null
	}

	async persistPendingState(): Promise<void> {
		// Early return if nothing to persist
		if (
			this.pendingGlobalState.size === 0 &&
			this.pendingSecrets.size === 0 &&
			this.pendingWorkspaceState.size === 0 &&
			this.pendingTaskState.size === 0
		) {
			return
		}

		await Promise.all([
			this.persistGlobalStateBatch(this.pendingGlobalState),
			this.persistSecretsBatch(this.pendingSecrets),
			this.persistWorkspaceStateBatch(this.pendingWorkspaceState),
			this.persistTaskStateBatch(this.pendingTaskState),
		])

		this.pendingGlobalState.clear()
		this.pendingSecrets.clear()
		this.pendingWorkspaceState.clear()
		this.pendingTaskState.clear()
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
		if (this.taskHistoryWatcher) {
			await this.taskHistoryWatcher.close()
			this.taskHistoryWatcher = null
		}
	}

	// ── Debounced scheduling ────────────────────────────────────────────

	private scheduleDebouncedPersistence(): void {
		if (this.persistenceTimeout) {
			clearTimeout(this.persistenceTimeout)
		}
		this.persistenceTimeout = setTimeout(async () => {
			try {
				await this.persistPendingState()
				this.persistenceTimeout = null
			} catch (error) {
				Logger.error("[StatePersistenceManager] Failed to persist pending changes:", error)
				this.persistenceTimeout = null
				this.onPersistenceError?.({ error: error })
			}
		}, this.PERSISTENCE_DELAY_MS)
	}

	// ── Batch persist implementations ───────────────────────────────────

	private async persistGlobalStateBatch(keys: Set<GlobalStateAndSettingsKey>): Promise<void> {
		const regularEntries: Record<string, any> = {}
		for (const key of keys) {
			if (key === "taskHistory") {
				// Route task history persistence to its own file
				await writeTaskHistoryToState(this.accessors.getGlobalStateValue(key))
			} else {
				regularEntries[key] = this.accessors.getGlobalStateValue(key)
			}
		}
		if (Object.keys(regularEntries).length > 0) {
			this.storage.globalStateBackingStore.setBatch(regularEntries)
		}
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

	async readAllFromDisk(): Promise<{ globalState: GlobalState; secrets: Secrets; workspaceState: LocalState }> {
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

	// ── Task-history file watcher ───────────────────────────────────────

	async setupTaskHistoryWatcher(isInitialized: () => boolean, onSyncExternalChange: () => void | Promise<void>): Promise<void> {
		try {
			const historyFile = await getTaskHistoryStateFilePath()

			if (this.taskHistoryWatcher) {
				await this.taskHistoryWatcher.close()
				this.taskHistoryWatcher = null
			}

			this.taskHistoryWatcher = chokidar.watch(historyFile, {
				persistent: true,
				ignoreInitial: true,
				atomic: true,
				awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
			})

			const syncTaskHistoryFromDisk = async () => {
				try {
					if (!isInitialized()) return
					const onDisk = await readTaskHistoryFromState()
					const cached = this.accessors.getGlobalStateValue("taskHistory")
					if (JSON.stringify(onDisk) !== JSON.stringify(cached)) {
						this.accessors.setTaskHistoryInCache(onDisk)
						await onSyncExternalChange()
					}
				} catch (err) {
					Logger.error("[StatePersistenceManager] Failed to reload task history on change:", err)
				}
			}

			this.taskHistoryWatcher
				.on("add", () => {
					syncTaskHistoryFromDisk()
				})
				.on("change", () => {
					syncTaskHistoryFromDisk()
				})
				.on("unlink", async () => {
					this.accessors.setTaskHistoryInCache([])
					await onSyncExternalChange()
				})
				.on("error", (error) => Logger.error("[StatePersistenceManager] TaskHistory watcher error:", error))
		} catch (err) {
			Logger.error("[StatePersistenceManager] Failed to set up taskHistory watcher:", err)
		}
	}
}
