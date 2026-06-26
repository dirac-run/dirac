import type { ApiConfiguration, ModelInfo } from "@shared/api"
import { getSecretsFromEnv, getSettingsFromEnv } from "@shared/storage/env-config"
import {
    ApiHandlerSettingsKeys,
    type GlobalState,
    type GlobalStateAndSettings,
    type GlobalStateAndSettingsKey,
    isSecretKey,
    isSettingsKey,
    type LocalState,
    type LocalStateKey,
    type SecretKey,
    SecretKeys,
    type Secrets,
    type Settings,
    type SettingsKey,
} from "@shared/storage/state-keys"
import type { StorageContext } from "@shared/storage/storage-context"
import { initializeDistinctId } from "@/services/logging/distinctId"
import { Logger } from "@/shared/services/Logger"
import { AgentConfigLoader } from "../task/tools/subagent/AgentConfigLoader"
import { STATE_MANAGER_NOT_INITIALIZED } from "./error-messages"
import { type PersistenceErrorEvent, StatePersistenceManager } from "./StatePersistenceManager"

// Re-export for backward compatibility — consumers import PersistenceErrorEvent from StateManager
export type { PersistenceErrorEvent }

/**
 * In-memory state manager for fast state access.
 * Provides immediate reads/writes with async disk persistence.
 *
 * All persistent storage is backed by file-based stores via StorageContext.
 * This is shared across all platforms (VSCode, CLI, JetBrains).
 *
 * MULTI-INSTANCE BEHAVIOR:
 * StateManager reads from disk ONLY during initialize(). After that, all reads come from
 * the in-memory cache. Writes update both the cache and disk, but other running instances
 * won't see those changes because they don't re-read from disk.
 *
 * This means: If you have multiple VS Code windows open, each has its own StateManager
 * instance with its own cache. Changing a setting (like plan/act mode) in Window A writes
 * to disk, but Window B keeps using its cached value. Window B only sees the change after
 * restart (when it re-initializes from disk).
 *
 * This is intentional for performance (avoids constant disk reads) and provides natural
 * isolation between concurrent instances. Task-specific state is independent anyway since
 * each window typically runs different tasks.
 */

export class StateManager {
	private static instance: StateManager | null = null

	private globalStateCache: GlobalStateAndSettings = {} as GlobalStateAndSettings
	private taskStateCache: Partial<Settings> = {}
	private sessionOverrideCache: Partial<Settings> = {}
	private secretsCache: Secrets = {} as Secrets
	private workspaceStateCache: LocalState = {} as LocalState

	private storage: StorageContext
	private persistence: StatePersistenceManager
	private isInitialized = false

	// Cache TTL: 1 hour - long enough to prevent duplicate fetches, short enough to see new models
	private readonly MODEL_CACHE_TTL_MS = 60 * 60 * 1000

	// In-memory model info cache (not persisted to disk) — keyed by `${provider}Models`
	private modelInfoCache: Record<string, { data: Record<string, ModelInfo>; timestamp: number } | null> = {}

	// Callback to sync external state changes with the UI client
	onSyncExternalChange?: () => void | Promise<void>

	// Delegate persistence-error callback to the persistence manager
	get onPersistenceError(): ((event: PersistenceErrorEvent) => void) | undefined {
		return this.persistence.onPersistenceError
	}
	set onPersistenceError(cb: ((event: PersistenceErrorEvent) => void) | undefined) {
		this.persistence.onPersistenceError = cb
	}

	// State change notification subscribers (from main)
	private stateChangeListeners = new Set<() => void>()

	private constructor(storage: StorageContext) {
		this.storage = storage
		this.persistence = new StatePersistenceManager(storage, {
			getGlobalStateValue: (key) => this.globalStateCache[key],
			getTaskStateValue: (key) => this.taskStateCache[key],
			getSecretValue: (key) => this.secretsCache[key],
			getWorkspaceStateValue: (key) => this.workspaceStateCache[key],
			setTaskHistoryInCache: (value) => {
				this.globalStateCache.taskHistory = value
			},
		})
	}

	/**
	 * Initialize the cache by loading data from the file-backed StorageContext.
	 */
	public static async initialize(storage: StorageContext): Promise<StateManager> {
		if (!StateManager.instance) {
			StateManager.instance = new StateManager(storage)
		}

		if (StateManager.instance.isInitialized) {
			throw new Error("StateManager has already been initialized.")
		}

		try {
			await initializeDistinctId(storage)

			// Load all extension state from file-backed stores
			const { globalState, secrets, workspaceState } = await StateManager.instance.persistence.readAllFromDisk()

			// Populate the cache with all extension state and secrets fields
			StateManager.instance.populateCache(globalState, secrets, workspaceState)

			// Start watcher for taskHistory.json so external edits update cache (no persist loop)
			await StateManager.instance.persistence.setupTaskHistoryWatcher(
				() => StateManager.instance?.isInitialized ?? false,
				async () => {
					await StateManager.instance?.onSyncExternalChange?.()
				},
			)

			StateManager.instance.isInitialized = true

			await AgentConfigLoader.getInstance().ready()
		} catch (error) {
			Logger.error("[StateManager] Failed to initialize:", error)
			throw error
		}

		return StateManager.instance
	}

	public static get(): StateManager {
		if (!StateManager.instance) {
			throw new Error("StateManager has not been initialized")
		}
		return StateManager.instance
	}

	/**
	 * Register callbacks for state manager events
	 */
	public registerCallbacks(callbacks: {
		onPersistenceError?: (event: PersistenceErrorEvent) => void | Promise<void>
		onSyncExternalChange?: () => void | Promise<void>
	}): void {
		if (callbacks.onPersistenceError) {
			this.persistence.onPersistenceError = callbacks.onPersistenceError as (event: PersistenceErrorEvent) => void
		}
		if (callbacks.onSyncExternalChange) {
			this.onSyncExternalChange = callbacks.onSyncExternalChange
		}
	}

	/**
	 * Subscribe to global state changes. The listener is called whenever global state
	 * is modified via setGlobalState or setGlobalStateBatch. Returns an unsubscribe function.
	 */
	public subscribe(listener: () => void): () => void {
		this.stateChangeListeners.add(listener)
		return () => {
			this.stateChangeListeners.delete(listener)
		}
	}

	private notifyStateChange(): void {
		for (const listener of this.stateChangeListeners) {
			listener()
		}
	}

	setGlobalState<K extends keyof GlobalStateAndSettings>(key: K, value: GlobalStateAndSettings[K]): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		this.globalStateCache[key] = value
		this.persistence.addPendingGlobalState(key)
		this.notifyStateChange()
	}

	setGlobalStateBatch(updates: Partial<GlobalStateAndSettings>): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		Object.assign(this.globalStateCache, updates)
		this.persistence.addPendingGlobalStateBatch(Object.keys(updates) as GlobalStateAndSettingsKey[])
		this.notifyStateChange()
	}

	setTaskSettings<K extends keyof Settings>(taskId: string, key: K, value: Settings[K]): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		this.taskStateCache[key] = value
		this.persistence.addPendingTaskState(taskId, key)
	}

	setTaskSettingsBatch(taskId: string, updates: Partial<Settings>): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		Object.assign(this.taskStateCache, updates)
		this.persistence.addPendingTaskStateBatch(taskId, Object.keys(updates) as SettingsKey[])
	}

	async loadTaskSettings(taskId: string): Promise<void> {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		const taskSettings = await this.persistence.loadTaskSettingsFromDisk(taskId)
		Object.assign(this.taskStateCache, taskSettings)
	}

	async clearTaskSettings(): Promise<void> {
		if (this.persistence.hasPendingTaskState()) {
			await this.persistence.persistAndClearPendingTaskState()
		}
		this.taskStateCache = {}
		this.persistence.clearPendingTaskState()
	}

	setSecret<K extends keyof Secrets>(key: K, value: Secrets[K]): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		this.secretsCache[key] = value
		this.persistence.addPendingSecret(key)
	}

	setSecretsBatch(updates: Partial<Secrets>): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		const changedKeys: SecretKey[] = []
		Object.entries(updates).forEach(([key, value]) => {
			// Skip unchanged values to avoid unnecessary writes & onDidChange events
			const current = this.secretsCache[key as keyof Secrets]
			if (current === value) return
			this.secretsCache[key as keyof Secrets] = value
			changedKeys.push(key as SecretKey)
		})
		this.persistence.addPendingSecretBatch(changedKeys)
	}

	setWorkspaceState<K extends keyof LocalState>(key: K, value: LocalState[K]): void
	setWorkspaceState(key: string, value: unknown): void
	setWorkspaceState(key: string, value: unknown): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		;(this.workspaceStateCache as Record<string, unknown>)[key] = value
		this.persistence.addPendingWorkspaceState(key as LocalStateKey)
	}

	setWorkspaceStateBatch(updates: Partial<LocalState>): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		const changedKeys: LocalStateKey[] = []
		Object.entries(updates).forEach(([key, value]) => {
			this.workspaceStateCache[key as keyof LocalState] = value
			changedKeys.push(key as LocalStateKey)
		})
		this.persistence.addPendingWorkspaceStateBatch(changedKeys)
	}

	setSessionOverride<K extends keyof Settings>(key: K, value: Settings[K]): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		this.sessionOverrideCache[key] = value
	}

	/** Return the current session-override cache (in-memory only). (from main) */
	getSessionOverrideCache(): Partial<Settings> {
		return this.sessionOverrideCache
	}

	/** Replace the session-override cache wholesale. In-memory only, never persisted. (from main) */
	setSessionOverrideCache(overrides: Partial<Settings>): void {
		this.sessionOverrideCache = { ...overrides }
	}

	setModelsCache(provider: string, models: Record<string, ModelInfo>): void {
		const cacheKey = `${provider}Models`
		this.modelInfoCache[cacheKey] = { data: models, timestamp: Date.now() }
	}

	getModelsCache(provider: string): Record<string, ModelInfo> | null {
		const cacheKey = `${provider}Models`
		const cached = this.modelInfoCache[cacheKey]
		if (!cached) return null
		if (Date.now() - cached.timestamp > this.MODEL_CACHE_TTL_MS) {
			this.modelInfoCache[cacheKey] = null
			return null
		}
		return cached.data
	}

	getModelInfo(
		provider: "openRouter" | "groq" | "baseten" | "huggingFace" | "requesty" | "huaweiCloudMaas" | "aihubmix" | "liteLlm",
		modelId: string,
	): ModelInfo | undefined {
		const cacheKey = `${provider}Models`
		const cached = this.modelInfoCache[cacheKey]
		if (!cached) return undefined
		if (Date.now() - cached.timestamp > this.MODEL_CACHE_TTL_MS) {
			this.modelInfoCache[cacheKey] = null
			return undefined
		}
		return cached.data[modelId]
	}

	getApiConfiguration(): ApiConfiguration {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		return this.constructApiConfigurationFromCache()
	}

	setApiConfiguration(apiConfiguration: ApiConfiguration): void {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)

		const { settingsUpdates, secretsUpdates } = Object.entries(apiConfiguration).reduce(
			(acc, [key, value]) => {
				if (key === undefined) return acc
				if (isSecretKey(key)) {
					(acc.secretsUpdates as Record<string, string | undefined>)[key] = value as string | undefined
				} else if (isSettingsKey(key)) {
					(acc.settingsUpdates as Record<string, unknown>)[key] = value
				}
				return acc
			},
			{ settingsUpdates: {} as Partial<Settings>, secretsUpdates: {} as Partial<Secrets> },
		)

		if (Object.keys(settingsUpdates).length > 0) this.setGlobalStateBatch(settingsUpdates)
		if (Object.keys(secretsUpdates).length > 0) this.setSecretsBatch(secretsUpdates)
	}

	getGlobalSettingsKey<K extends keyof Settings>(key: K): Settings[K] {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		// Precedence: session override > task settings > global settings
		if (this.sessionOverrideCache[key] !== undefined) return this.sessionOverrideCache[key] as Settings[K]
		if (this.taskStateCache[key] !== undefined) return this.taskStateCache[key]
		return this.globalStateCache[key]
	}

	getGlobalStateKey<K extends keyof GlobalState>(key: K): GlobalState[K] {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		return this.globalStateCache[key]
	}

	getSecretKey<K extends keyof Secrets>(key: K): Secrets[K] {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		return this.secretsCache[key]
	}

	getWorkspaceStateKey<K extends keyof LocalState>(key: K): LocalState[K]
	getWorkspaceStateKey(key: string): unknown
	getWorkspaceStateKey(key: string): unknown {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		return (this.workspaceStateCache as Record<string, unknown>)[key]
	}

	async reInitialize(currentTaskId?: string): Promise<void> {
		if (this.persistence.hasPendingTimeout()) {
			await this.persistence.persistPendingState()
		}
		await this.dispose()
		await StateManager.initialize(this.storage)
		if (currentTaskId) await this.loadTaskSettings(currentTaskId)
	}

	private async dispose(): Promise<void> {
		this.sessionOverrideCache = {}
		this.isInitialized = false
		await this.persistence.dispose()
	}

	async flushPendingState(): Promise<void> {
		await this.persistence.flushPendingState()
	}

	getAllGlobalStateEntries(): Record<string, unknown> {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		return { ...this.globalStateCache }
	}

	getAllWorkspaceStateEntries(): Record<string, unknown> {
		if (!this.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		return { ...this.workspaceStateCache }
	}

	private populateCache(globalState: GlobalState, secrets: Secrets, workspaceState: LocalState): void {
		Object.assign(this.globalStateCache, globalState)
		Object.assign(this.secretsCache, secrets)
		Object.assign(this.workspaceStateCache, workspaceState)
	}

	private getSettingWithOverride<K extends keyof Settings>(key: K): Settings[K] {
		// Precedence: session override > task settings > global settings
		if (this.sessionOverrideCache[key] !== undefined) return this.sessionOverrideCache[key]
		const taskValue = this.taskStateCache[key]
		if (taskValue !== undefined) return taskValue
		return this.globalStateCache[key]
	}

	private getSecret<K extends keyof Secrets>(key: K): Secrets[K] {
		return this.secretsCache[key]
	}

	private constructApiConfigurationFromCache(): ApiConfiguration {
		// Build secrets object from persistent storage
		const secrets = Object.fromEntries(SecretKeys.map((key) => [key, this.getSecret(key)])) as Secrets

		// Merge environment variables as fallback
		const envSecrets = getSecretsFromEnv()
		for (const [key, value] of Object.entries(envSecrets)) {
			if (value && !secrets[key as keyof Secrets]) {
				secrets[key as keyof Secrets] = value
			}
		}

		// Build API handler settings object with task override support
		const settings: Partial<Settings> = Object.fromEntries(ApiHandlerSettingsKeys.map((key) => [key, this.getSettingWithOverride(key)]))

		// Merge environment variables as fallback for settings (only fills undefined values)
		const envSettings = getSettingsFromEnv()
		for (const [key, value] of Object.entries(envSettings)) {
			if (value && isSettingsKey(key) && settings[key] === undefined) {
				(settings as Record<string, unknown>)[key] = value
			}
		}

		return { ...secrets, ...settings } satisfies ApiConfiguration
	}
}
