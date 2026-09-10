import type { ApiConfiguration, ModelProviderPreset } from "@shared/api"
import {
	getExplicitDiracSecretsFromEnv,
	getExplicitDiracSettingsFromEnv,
	getSecretsFromEnv,
	getSettingsFromEnv,
} from "@shared/storage/env-config"
import {
	normalizeLegacyModelProviderPresets,
	buildLegacyAnthropicFastModeStateUpdates,
	buildRetiredDeepSeekModelStateUpdates,
	normalizeLegacyOpenRouterPinMap,
	normalizeLegacySynthetic1mModelId,
} from "@shared/storage/legacy-model-id-migration"
import { normalizeInferenceSpeed } from "@shared/storage/types"
import {
	ApiHandlerSettingsKeys,
	type GlobalStateAndSettings,
	isSecretKey,
	isSettingsKey,
	SecretKeys,
	type Secrets,
	type Settings,
	SettingsKeys,
} from "@shared/storage/state-keys"

export interface StateManagerSettingsCaches {
	sessionOverrideCache: Partial<Settings>
	taskStateCache: Partial<Settings>
	globalStateCache: GlobalStateAndSettings
	secretsCache: Secrets
}

export function normalizeLoadedSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
	if (typeof value === "string" && (key.endsWith("ModelId") || key.endsWith("ModelBaseId"))) {
		return normalizeLegacySynthetic1mModelId(value) as Settings[K]
	}
	if (key === "openRouterPinnedProviders") {
		return normalizeLegacyOpenRouterPinMap(value as Record<string, string[]> | undefined) as Settings[K]
	}
	if (key === "modelProviderPresets") {
		return normalizeLegacyModelProviderPresets(value as ModelProviderPreset[]) as Settings[K]
	}
	if (key === "planModeInferenceSpeed" || key === "actModeInferenceSpeed") {
		return normalizeInferenceSpeed(value) as Settings[K]
	}
	return value
}

export function normalizeLoadedSettings(settings: Partial<Settings>): Partial<Settings> {
	const normalized = { ...settings }
	for (const [key, value] of Object.entries(normalized)) {
		; (normalized as Record<string, unknown>)[key] = normalizeLoadedSetting(key as keyof Settings, value as never)
	}
	Object.assign(normalized, buildLegacyAnthropicFastModeStateUpdates(normalized))
	Object.assign(normalized, buildRetiredDeepSeekModelStateUpdates(normalized))
	return normalized
}

export function getSettingWithOverride<K extends keyof Settings>(
	key: K,
	caches: Pick<StateManagerSettingsCaches, "sessionOverrideCache" | "taskStateCache" | "globalStateCache">,
): Settings[K] {
	if (Object.hasOwn(caches.sessionOverrideCache, key)) return caches.sessionOverrideCache[key] as Settings[K]
	const taskValue = caches.taskStateCache[key]
	if (taskValue !== undefined) return taskValue
	return caches.globalStateCache[key]
}

export function getSecret<K extends keyof Secrets>(key: K, secretsCache: Secrets): Secrets[K] {
	return secretsCache[key]
}

function resolutionCaches(caches: StateManagerSettingsCaches, explicitOverrides?: Partial<Settings>): StateManagerSettingsCaches {
	if (!explicitOverrides) return caches
	return {
		...caches,
		// Explicit runtime inputs are the highest-precedence, session-like layer.
		// Spreading preserves owned undefined values that block inheritance.
		sessionOverrideCache: {
			...caches.sessionOverrideCache,
			...normalizeLoadedSettings(explicitOverrides),
		},
	}
}

/** Resolve every Settings field through the existing session > task > global precedence. */
export function buildEffectiveSettingsFromCache(
	caches: StateManagerSettingsCaches,
	explicitOverrides?: Partial<Settings>,
): Settings {
	const resolvedCaches = resolutionCaches(caches, explicitOverrides)
	const settings = Object.fromEntries(SettingsKeys.map((key) => [key, getSettingWithOverride(key, resolvedCaches)])) as Settings

	// Environment-backed API settings historically participate only in API
	// configuration construction. Include them in the task settings snapshot so
	// provider/model reporting cannot disagree with API configuration.
	const envSettings = getSettingsFromEnv()
	for (const [key, value] of Object.entries(envSettings)) {
		if (
			value &&
			isSettingsKey(key) &&
			ApiHandlerSettingsKeys.includes(key as never) &&
			settings[key] === undefined &&
			!Object.hasOwn(resolvedCaches.sessionOverrideCache, key)
		) {
			; (settings as Record<string, unknown>)[key] = normalizeLoadedSetting(key, value as never)
		}
	}
	for (const [key, value] of Object.entries(getExplicitDiracSettingsFromEnv())) {
		if (
			value !== undefined &&
			isSettingsKey(key) &&
			ApiHandlerSettingsKeys.includes(key as never) &&
			!Object.hasOwn(resolvedCaches.sessionOverrideCache, key)
		) {
			; (settings as Record<string, unknown>)[key] = normalizeLoadedSetting(key, value as never)
		}
	}

	return settings
}

/** Build API configuration without installing explicit runtime overrides in StateManager. */
export function buildEffectiveApiConfigurationFromCache(
	caches: StateManagerSettingsCaches,
	explicitOverrides?: Partial<Settings>,
): ApiConfiguration {
	const effectiveSettings = buildEffectiveSettingsFromCache(caches, explicitOverrides)
	const secrets = Object.fromEntries(
		SecretKeys.map((key) => [key, getSecret(key as keyof Secrets, caches.secretsCache)]),
	) as Secrets
	const envSecrets = getSecretsFromEnv()
	for (const [key, value] of Object.entries(envSecrets)) {
		if (value && !secrets[key as keyof Secrets]) secrets[key as keyof Secrets] = value
	}
	Object.assign(secrets, getExplicitDiracSecretsFromEnv())

	const settings = Object.fromEntries(ApiHandlerSettingsKeys.map((key) => [key, effectiveSettings[key]])) as Partial<Settings>
	return { ...secrets, ...settings } satisfies ApiConfiguration
}

export function buildApiConfigurationFromCache(caches: StateManagerSettingsCaches): ApiConfiguration {
	return buildEffectiveApiConfigurationFromCache(caches)
}

export { isSecretKey, isSettingsKey }
