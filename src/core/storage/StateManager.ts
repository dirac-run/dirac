import type { ApiConfiguration, ModelInfo } from "@shared/api"
import type { RunHistoryItem } from "@shared/HistoryItem"
import { buildLegacyModelIdStateUpdates } from "@shared/storage/legacy-model-id-migration"
import { initializeStateAccess } from "@shared/storage/state-access-provider"
import {
    type GlobalState,
    type GlobalStateAndSettings,
    type LocalState,
    type Secrets,
    type Settings,
} from "@shared/storage/state-keys"
import type { StorageContext } from "@shared/storage/storage-context"
import { initializeDistinctId } from "@/services/logging/distinctId"
import { Logger } from "@/shared/services/Logger"
import {
    createTaskWorkingConfiguration,
    type TaskExecutionOptions,
    type TaskWorkingConfiguration,
} from "../task/runtime/TaskWorkingConfiguration"
import { AgentConfigLoader } from "../task/tools/subagent/AgentConfigLoader"
import {
    getAllGlobalStateEntries,
    getAllWorkspaceStateEntries,
    getApiConfiguration,
    getGlobalSettingsKey,
    getGlobalStateKey,
    getSecretKey,
    getSystemDefaultSettingsKey,
    getWorkspaceStateKey,
    type StateManagerGetterCaches,
} from "./StateManagerGetters"
import { getModelInfo, getModelsCache, type ModelCache, setModelsCache } from "./StateManagerModelCache"
import {
    clearSessionOverride,
    clearTaskSetting,
    clearTaskSettings,
    getTaskSetting,
    hasSessionOverride,
    hasTaskSetting,
    loadTaskSettings,
    mutateTaskHistory,
    refreshModelProviderPresetsFromDisk,
    type StateManagerSettersContext,
    setApiConfiguration,
    setGlobalState,
    setGlobalStateBatch,
    setSecret,
    setSecretsBatch,
    setSessionOverride,
    setTaskSettings,
    setTaskSettingsBatch,
    setWorkspaceState,
    setWorkspaceStateBatch,
} from "./StateManagerSetters"
import {
    buildEffectiveApiConfigurationFromCache,
    buildEffectiveSettingsFromCache,
    type StateManagerSettingsCaches,
} from "./StateManagerSettings"
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
 * Settings are read from disk during initialize() and then remain isolated in each
 * instance's cache. Task history is the exception: it is a shared multi-writer index,
 * synchronized through ID-scoped transactions and a file watcher.
 *
 * This means: If you have multiple VS Code windows open, each has its own StateManager
 * instance with its own cache. Changing a setting (like plan/act mode) in Window A writes
 * to disk, but Window B keeps using its cached value. Window B only sees the change after
 * restart (when it re-initializes from disk). Task-history changes are merged and become
 * visible in every running instance without a restart.
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

	// In-memory model info cache (not persisted to disk) — keyed by `${provider}Models`
	private modelInfoCache: ModelCache = {}

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
			onTaskHistoryCommitMerged: () => {
				this.notifyStateChange()
				void Promise.resolve(this.onSyncExternalChange?.()).catch((error) => {
					Logger.error("[StateManager] Failed to publish merged task history:", error)
				})
			},
		})
	}

	private get settingsCaches(): StateManagerSettingsCaches {
		return {
			sessionOverrideCache: this.sessionOverrideCache,
			taskStateCache: this.taskStateCache,
			globalStateCache: this.globalStateCache,
			secretsCache: this.secretsCache,
		}
	}

	private get allCaches(): StateManagerGetterCaches {
		return {
			...this.settingsCaches,
			workspaceStateCache: this.workspaceStateCache,
		}
	}

	private get settersContext(): StateManagerSettersContext {
		return {
			isInitialized: this.isInitialized,
			globalStateCache: this.globalStateCache,
			taskStateCache: this.taskStateCache,
			sessionOverrideCache: this.sessionOverrideCache,
			secretsCache: this.secretsCache,
			workspaceStateCache: this.workspaceStateCache,
			persistence: this.persistence,
			notifyStateChange: () => this.notifyStateChange(),
		}
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
			const rawLegacyUtilityModelEnabled = storage.globalStateBackingStore.get<boolean>("utilityModelEnabled")
			const rawUtilityModelUseCondense = storage.globalStateBackingStore.get<boolean>("utilityModelUseCondense")
			const rawUtilityModelUseNewTask = storage.globalStateBackingStore.get<boolean>("utilityModelUseNewTask")
			const rawUtilityModelUseGenerateCommitMessage = storage.globalStateBackingStore.get<boolean>(
				"utilityModelUseGenerateCommitMessage",
			)
			const legacyModelIdUpdates = buildLegacyModelIdStateUpdates(globalState)
			if (Object.keys(legacyModelIdUpdates).length > 0) {
				await storage.globalStateBackingStore.setBatch(legacyModelIdUpdates)
				Object.assign(globalState, legacyModelIdUpdates)
			}

			// Split the legacy Utility switch into independent use cases without changing an
			// existing user's intent. Read directly from the backing store because the
			// normalized state reader fills missing settings with their defaults.
			const utilityUseCaseUpdates: Partial<
				Pick<Settings, "utilityModelUseCondense" | "utilityModelUseNewTask" | "utilityModelUseGenerateCommitMessage">
			> = {}
			if (rawLegacyUtilityModelEnabled !== undefined) {
				const enabled = rawLegacyUtilityModelEnabled === true
				if (rawUtilityModelUseCondense === undefined) utilityUseCaseUpdates.utilityModelUseCondense = enabled
				if (rawUtilityModelUseNewTask === undefined) utilityUseCaseUpdates.utilityModelUseNewTask = enabled
				if (rawUtilityModelUseGenerateCommitMessage === undefined) {
					utilityUseCaseUpdates.utilityModelUseGenerateCommitMessage = enabled
				}
			}
			if (Object.keys(utilityUseCaseUpdates).length > 0) {
				await storage.globalStateBackingStore.setBatch(utilityUseCaseUpdates)
				Object.assign(globalState, utilityUseCaseUpdates)
			}

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

			// Register the leaf-facing state seam — services/integrations resolve state through
			// shared/state-access-provider without importing core.
			initializeStateAccess(() => (StateManager.isInitialized() ? StateManager.instance : undefined) ?? undefined)

			await AgentConfigLoader.getInstance().ready()
		} catch (error) {
			Logger.error("[StateManager] Failed to initialize:", error)
			throw error
		}

		return StateManager.instance
	}

	public static isInitialized(): boolean {
		return StateManager.instance?.isInitialized === true
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
	 * is modified through StateManager setters. Returns an unsubscribe function.
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
		setGlobalState(this.settersContext, key, value)
	}

	refreshModelProviderPresetsFromDisk(): void {
		refreshModelProviderPresetsFromDisk(this.settersContext)
	}

	setGlobalStateBatch(updates: Partial<GlobalStateAndSettings>): void {
		setGlobalStateBatch(this.settersContext, updates)
	}

	upsertTaskHistoryItem(item: RunHistoryItem): RunHistoryItem[] {
		return mutateTaskHistory(this.settersContext, { kind: "upsert", item })
	}

	setTaskHistoryFavorite(id: string, isFavorited: boolean): RunHistoryItem[] {
		return mutateTaskHistory(this.settersContext, { kind: "setFavorite", id, isFavorited })
	}

	removeTaskHistoryItems(ids: string[]): RunHistoryItem[] {
		return mutateTaskHistory(this.settersContext, { kind: "remove", ids })
	}

	insertMissingTaskHistoryItems(items: RunHistoryItem[]): RunHistoryItem[] {
		return mutateTaskHistory(this.settersContext, { kind: "insertMissing", items })
	}

	replaceTaskHistory(items: RunHistoryItem[]): RunHistoryItem[] {
		return mutateTaskHistory(this.settersContext, { kind: "replace", items })
	}

	setTaskSettings<K extends keyof Settings>(taskId: string, key: K, value: Settings[K]): void {
		setTaskSettings(this.settersContext, taskId, key, value)
	}

	setTaskSettingsBatch(taskId: string, updates: Partial<Settings>): void {
		setTaskSettingsBatch(this.settersContext, taskId, updates)
	}

	hasTaskSetting<K extends keyof Settings>(key: K): boolean {
		return hasTaskSetting(this.settersContext, key)
	}

	getTaskSetting<K extends keyof Settings>(key: K): Settings[K] | undefined {
		return getTaskSetting(this.settersContext, key)
	}

	clearTaskSetting<K extends keyof Settings>(taskId: string, key: K): void {
		clearTaskSetting(this.settersContext, taskId, key)
	}

	async loadTaskSettings(taskId: string): Promise<void> {
		await loadTaskSettings(this.settersContext, taskId)
	}

	async clearTaskSettings(): Promise<void> {
		await clearTaskSettings(this.settersContext)
	}

	setSecret<K extends keyof Secrets>(key: K, value: Secrets[K]): void {
		setSecret(this.settersContext, key, value)
	}

	setSecretsBatch(updates: Partial<Secrets>): void {
		setSecretsBatch(this.settersContext, updates)
	}

	setWorkspaceState<K extends keyof LocalState>(key: K, value: LocalState[K]): void
	setWorkspaceState(key: string, value: unknown): void
	setWorkspaceState(key: string, value: unknown): void {
		setWorkspaceState(this.settersContext, key, value)
	}

	setWorkspaceStateBatch(updates: Partial<LocalState>): void {
		setWorkspaceStateBatch(this.settersContext, updates)
	}

	setSessionOverride<K extends keyof Settings>(key: K, value: Settings[K]): void {
		setSessionOverride(this.settersContext, key, value)
	}

	hasSessionOverride<K extends keyof Settings>(key: K): boolean {
		return hasSessionOverride(this.settersContext, key)
	}

	clearSessionOverride<K extends keyof Settings>(key: K): void {
		clearSessionOverride(this.settersContext, key)
	}

	setModelsCache(provider: string, models: Record<string, ModelInfo>): void {
		setModelsCache(this.modelInfoCache, provider, models)
	}

	getModelsCache(provider: string): Record<string, ModelInfo> | null {
		return getModelsCache(this.modelInfoCache, provider)
	}

	getModelInfo(
		provider: "openRouter" | "groq" | "baseten" | "huggingFace" | "requesty" | "huaweiCloudMaas" | "aihubmix" | "liteLlm",
		modelId: string,
	): ModelInfo | undefined {
		return getModelInfo(this.modelInfoCache, provider, modelId)
	}

	getApiConfiguration(): ApiConfiguration {
		return getApiConfiguration(this.settingsCaches, this.isInitialized)
	}

	/**
	 * Capture a detached task-owned effective configuration from already loaded state.
	 * Explicit runtime overrides participate as a highest-precedence, session-like
	 * input but are never installed into StateManager caches.
	 */
	captureEffectiveTaskConfiguration(
		explicitOverrides?: Partial<Settings>,
		executionOptions?: Partial<TaskExecutionOptions>,
	): TaskWorkingConfiguration {
		if (!this.isInitialized) throw new Error("StateManager has not been initialized")

		return createTaskWorkingConfiguration({
			revision: 1,
			settings: buildEffectiveSettingsFromCache(this.settingsCaches, explicitOverrides),
			apiConfiguration: buildEffectiveApiConfigurationFromCache(this.settingsCaches, explicitOverrides),
			workspaceConfiguration: this.workspaceStateCache,
			executionOptions: {
				terminalReuseEnabled: executionOptions?.terminalReuseEnabled ?? this.globalStateCache.terminalReuseEnabled,
				vscodeTerminalExecutionMode:
					executionOptions?.vscodeTerminalExecutionMode ?? this.globalStateCache.vscodeTerminalExecutionMode,
				multiRootEnabled: executionOptions?.multiRootEnabled ?? this.globalStateCache.multiRootEnabled,
			},
		})
	}

	setApiConfiguration(apiConfiguration: ApiConfiguration): void {
		setApiConfiguration(this.settersContext, apiConfiguration)
	}

	getGlobalSettingsKey<K extends keyof Settings>(key: K): Settings[K] {
		return getGlobalSettingsKey(key, this.settingsCaches, this.isInitialized)
	}

	/** Read a system default without inheriting active session or task state. */
	getSystemDefaultSettingsKey<K extends keyof Settings>(key: K): Settings[K] {
		return getSystemDefaultSettingsKey(key, this.settingsCaches, this.isInitialized)
	}

	getGlobalStateKey<K extends keyof GlobalState>(key: K): GlobalState[K] {
		return getGlobalStateKey(key, this.settingsCaches, this.isInitialized)
	}

	getSecretKey<K extends keyof Secrets>(key: K): Secrets[K] {
		return getSecretKey(key, this.settingsCaches, this.isInitialized)
	}

	getWorkspaceStateKey<K extends keyof LocalState>(key: K): LocalState[K]
	getWorkspaceStateKey(key: string): unknown
	getWorkspaceStateKey(key: string): unknown {
		return getWorkspaceStateKey(this.allCaches, this.isInitialized, key)
	}

	async reInitialize(currentTaskId?: string): Promise<void> {
		await this.persistence.flushPendingState()
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
		return getAllGlobalStateEntries(this.settingsCaches, this.isInitialized)
	}

	getAllWorkspaceStateEntries(): Record<string, unknown> {
		return getAllWorkspaceStateEntries(this.allCaches, this.isInitialized)
	}

	private populateCache(globalState: GlobalState, secrets: Secrets, workspaceState: LocalState): void {
		Object.assign(this.globalStateCache, globalState)
		Object.assign(this.secretsCache, secrets)
		Object.assign(this.workspaceStateCache, workspaceState)
	}
}
