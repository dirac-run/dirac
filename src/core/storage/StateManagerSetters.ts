import type { ApiConfiguration, ModelProviderPreset } from "@shared/api"
import type { RunHistoryItem } from "@shared/HistoryItem"
import {
	type GlobalStateAndSettings,
	type GlobalStateAndSettingsKey,
	isSecretKey,
	isSettingsKey,
	type LocalState,
	type LocalStateKey,
	type SecretKey,
	type Secrets,
	type Settings,
	type SettingsKey,
} from "@shared/storage/state-keys"
import { STATE_MANAGER_NOT_INITIALIZED } from "./error-messages"
import { normalizeLoadedSetting, normalizeLoadedSettings } from "./StateManagerSettings"
import type { StatePersistenceManager } from "./StatePersistenceManager"
import { applyTaskHistoryMutations, type TaskHistoryMutation } from "./taskHistory"

export interface StateManagerSettersContext {
	isInitialized: boolean
	globalStateCache: GlobalStateAndSettings
	taskStateCache: Partial<Settings>
	sessionOverrideCache: Partial<Settings>
	secretsCache: Secrets
	workspaceStateCache: LocalState
	persistence: StatePersistenceManager
	notifyStateChange: () => void
}

function guardInitialized(ctx: StateManagerSettersContext): void {
	if (!ctx.isInitialized) throw new Error(STATE_MANAGER_NOT_INITIALIZED)
}

export function setGlobalState<K extends keyof GlobalStateAndSettings>(
	ctx: StateManagerSettersContext,
	key: K,
	value: GlobalStateAndSettings[K],
): void {
	guardInitialized(ctx)
	if (key === "taskHistory") throw new Error("Task history requires an ID-scoped mutation")
	const normalizedValue = isSettingsKey(key) ? normalizeLoadedSetting(key as SettingsKey, value as never) : value
		; (ctx.globalStateCache as Record<string, unknown>)[key] = normalizedValue
	ctx.persistence.addPendingGlobalState(key)
	ctx.notifyStateChange()
}

export function setGlobalStateBatch(ctx: StateManagerSettersContext, updates: Partial<GlobalStateAndSettings>): void {
	guardInitialized(ctx)
	if (Object.hasOwn(updates, "taskHistory")) throw new Error("Task history requires an ID-scoped mutation")
	const normalizedUpdates = normalizeLoadedSettings(updates as Partial<Settings>) as Partial<GlobalStateAndSettings>
	Object.assign(ctx.globalStateCache, normalizedUpdates)
	ctx.persistence.addPendingGlobalStateBatch(Object.keys(normalizedUpdates) as GlobalStateAndSettingsKey[])
	ctx.notifyStateChange()
}

export function mutateTaskHistory(
	ctx: StateManagerSettersContext,
	mutation: TaskHistoryMutation,
): RunHistoryItem[] {
	guardInitialized(ctx)
	const immutableMutation = structuredClone(mutation)
	const updated = applyTaskHistoryMutations(ctx.globalStateCache.taskHistory, [immutableMutation])
	ctx.globalStateCache.taskHistory = updated
	ctx.persistence.addPendingTaskHistoryMutation(immutableMutation)
	ctx.notifyStateChange()
	return updated
}

export function setTaskSettings<K extends keyof Settings>(
	ctx: StateManagerSettersContext,
	taskId: string,
	key: K,
	value: Settings[K],
): void {
	guardInitialized(ctx)
	if (key === "subagentRoles") throw new Error("Subagent roles are user-global settings")
	if (key === "sandboxSettings") throw new Error("Sandbox settings are user-global settings")
	if (key === "addedApiProviders") throw new Error("Added API providers are user-global settings")
	ctx.taskStateCache[key] = normalizeLoadedSetting(key, value)
	ctx.persistence.addPendingTaskState(taskId, key)
}

export function setTaskSettingsBatch(ctx: StateManagerSettersContext, taskId: string, updates: Partial<Settings>): void {
	guardInitialized(ctx)
	if (Object.hasOwn(updates, "subagentRoles")) throw new Error("Subagent roles are user-global settings")
	if (Object.hasOwn(updates, "sandboxSettings")) throw new Error("Sandbox settings are user-global settings")
	if (Object.hasOwn(updates, "addedApiProviders")) throw new Error("Added API providers are user-global settings")
	const normalizedUpdates = normalizeLoadedSettings(updates)
	Object.assign(ctx.taskStateCache, normalizedUpdates)
	ctx.persistence.addPendingTaskStateBatch(taskId, Object.keys(normalizedUpdates) as SettingsKey[])
}

export function hasTaskSetting<K extends keyof Settings>(ctx: StateManagerSettersContext, key: K): boolean {
	guardInitialized(ctx)
	return Object.hasOwn(ctx.taskStateCache, key)
}

export function getTaskSetting<K extends keyof Settings>(ctx: StateManagerSettersContext, key: K): Settings[K] | undefined {
	guardInitialized(ctx)
	return ctx.taskStateCache[key]
}

export function clearTaskSetting<K extends keyof Settings>(ctx: StateManagerSettersContext, taskId: string, key: K): void {
	guardInitialized(ctx)
	delete ctx.taskStateCache[key]
	ctx.persistence.addPendingTaskState(taskId, key)
}

export async function loadTaskSettings(ctx: StateManagerSettersContext, taskId: string): Promise<void> {
	guardInitialized(ctx)
	const taskSettings = (await ctx.persistence.loadTaskSettingsFromDisk(taskId)) as Partial<Settings>
	delete taskSettings.subagentRoles
	delete taskSettings.sandboxSettings
	delete taskSettings.addedApiProviders
	const normalizedTaskSettings = normalizeLoadedSettings(taskSettings)
	Object.assign(ctx.taskStateCache, normalizedTaskSettings)
	if (JSON.stringify(normalizedTaskSettings) !== JSON.stringify(taskSettings)) {
		ctx.persistence.addPendingTaskStateBatch(taskId, Object.keys(normalizedTaskSettings) as SettingsKey[])
	}
}

export async function clearTaskSettings(ctx: StateManagerSettersContext): Promise<void> {
	if (ctx.persistence.hasPendingTaskState()) {
		await ctx.persistence.persistAndClearPendingTaskState()
	}
	for (const key of Object.keys(ctx.taskStateCache)) {
		delete ctx.taskStateCache[key as keyof Settings]
	}
	ctx.persistence.clearPendingTaskState()
}

export function setSecret<K extends keyof Secrets>(ctx: StateManagerSettersContext, key: K, value: Secrets[K]): void {
	guardInitialized(ctx)
	ctx.secretsCache[key] = value
	ctx.persistence.addPendingSecret(key)
}

export function setSecretsBatch(ctx: StateManagerSettersContext, updates: Partial<Secrets>): void {
	guardInitialized(ctx)
	const changedKeys: SecretKey[] = []
	Object.entries(updates).forEach(([key, value]) => {
		const current = ctx.secretsCache[key as keyof Secrets]
		if (current === value) return
		ctx.secretsCache[key as keyof Secrets] = value
		changedKeys.push(key as SecretKey)
	})
	ctx.persistence.addPendingSecretBatch(changedKeys)
}

export function setWorkspaceState(ctx: StateManagerSettersContext, key: string, value: unknown): void {
	guardInitialized(ctx)
	if (key === "subagentRoles") throw new Error("Subagent roles are user-global settings")
	if (key === "sandboxSettings") throw new Error("Sandbox settings are user-global settings")
	if (key === "addedApiProviders") throw new Error("Added API providers are user-global settings")
		; (ctx.workspaceStateCache as Record<string, unknown>)[key] = value
	ctx.persistence.addPendingWorkspaceState(key as LocalStateKey)
}

export function setWorkspaceStateBatch(ctx: StateManagerSettersContext, updates: Partial<LocalState>): void {
	guardInitialized(ctx)
	if (Object.hasOwn(updates, "subagentRoles")) throw new Error("Subagent roles are user-global settings")
	if (Object.hasOwn(updates, "sandboxSettings")) throw new Error("Sandbox settings are user-global settings")
	if (Object.hasOwn(updates, "addedApiProviders")) throw new Error("Added API providers are user-global settings")
	const changedKeys: LocalStateKey[] = []
	Object.entries(updates).forEach(([key, value]) => {
		ctx.workspaceStateCache[key as keyof LocalState] = value
		changedKeys.push(key as LocalStateKey)
	})
	ctx.persistence.addPendingWorkspaceStateBatch(changedKeys)
}

export function setSessionOverride<K extends keyof Settings>(ctx: StateManagerSettersContext, key: K, value: Settings[K]): void {
	guardInitialized(ctx)
	if (key === "subagentRoles") throw new Error("Subagent roles are user-global settings")
	if (key === "sandboxSettings") throw new Error("Sandbox settings are user-global settings")
	if (key === "addedApiProviders") throw new Error("Added API providers are user-global settings")
	ctx.sessionOverrideCache[key] = normalizeLoadedSetting(key, value)
}


export function hasSessionOverride<K extends keyof Settings>(ctx: StateManagerSettersContext, key: K): boolean {
	guardInitialized(ctx)
	return Object.hasOwn(ctx.sessionOverrideCache, key)
}

export function clearSessionOverride<K extends keyof Settings>(ctx: StateManagerSettersContext, key: K): void {
	guardInitialized(ctx)
	delete ctx.sessionOverrideCache[key]
}


export function refreshModelProviderPresetsFromDisk(ctx: StateManagerSettersContext): void {
	guardInitialized(ctx)

	const cachedPresets = ctx.globalStateCache.modelProviderPresets
	const diskPresets = ctx.persistence.readGlobalStateKeyFromDisk("modelProviderPresets") as ModelProviderPreset[] | undefined
	const presetsById = new Map<string, ModelProviderPreset>()

	for (const preset of [...cachedPresets, ...(diskPresets || [])]) {
		const existing = presetsById.get(preset.id)
		if (!existing || preset.lastUsedAt > existing.lastUsedAt) presetsById.set(preset.id, preset)
	}

	const mergedPresets = [...presetsById.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 20)
	if (JSON.stringify(mergedPresets) === JSON.stringify(cachedPresets)) return
	setGlobalState(ctx, "modelProviderPresets", mergedPresets)
}

export function setApiConfiguration(ctx: StateManagerSettersContext, apiConfiguration: ApiConfiguration): void {
	guardInitialized(ctx)

	const { settingsUpdates, secretsUpdates } = Object.entries(apiConfiguration).reduce(
		(acc, [key, value]) => {
			if (key === undefined) return acc
			if (isSecretKey(key)) {
				; (acc.secretsUpdates as Record<string, string | undefined>)[key] = value as string | undefined
			} else if (isSettingsKey(key)) {
				; (acc.settingsUpdates as Record<string, unknown>)[key] = value
			}
			return acc
		},
		{ settingsUpdates: {} as Partial<Settings>, secretsUpdates: {} as Partial<Secrets> },
	)

	if (Object.keys(settingsUpdates).length > 0) setGlobalStateBatch(ctx, settingsUpdates)
	if (Object.keys(secretsUpdates).length > 0) setSecretsBatch(ctx, secretsUpdates)
}
