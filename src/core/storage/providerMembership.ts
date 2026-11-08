import * as fs from "node:fs"
import { getQwenCachedCredentialPath } from "@/utils/qwenCodeCredentialPath"
import type { ApiConfiguration } from "@shared/api"
import { getConfiguredApiProviders } from "@shared/configuredApiProviders"
import {
	getExplicitDiracSecretsFromEnv,
	getExplicitDiracSettingsFromEnv,
	getSecretsFromEnv,
	getSettingsFromEnv,
} from "@shared/storage/env-config"
import { ApiHandlerSettingsKeys, SecretKeys, type Secrets, type Settings } from "@shared/storage/state-keys"

interface ProviderMembershipStorage {
	getSystemDefaultSettingsKey<K extends keyof Settings>(key: K): Settings[K]
	getSecretKey<K extends keyof Secrets>(key: K): Secrets[K]
}

/** Publish membership from global setup; active-task overrides must not hide saved providers. */
export function getProviderMembershipState(
	stateManager: ProviderMembershipStorage,
) {
	const addedApiProviders = stateManager.getSystemDefaultSettingsKey("addedApiProviders")
	const apiConfiguration: ApiConfiguration = Object.fromEntries([
		...ApiHandlerSettingsKeys.map((key) => [key, stateManager.getSystemDefaultSettingsKey(key)]),
		...SecretKeys.map((key) => [key, stateManager.getSecretKey(key)]),
	])
	// Existing environment-backed setups remain selectable too, without replacing saved evidence.
	const environmentProviders = getConfiguredApiProviders({
		apiConfiguration: {
			...getSettingsFromEnv(),
			...getSecretsFromEnv(),
			...getExplicitDiracSettingsFromEnv(),
			...getExplicitDiracSecretsFromEnv(),
		},
	})
	return {
		addedApiProviders,
		configuredApiProviders: getConfiguredApiProviders({
			apiConfiguration,
			addedApiProviders: [...(addedApiProviders ?? []), ...environmentProviders],
			// Presence is saved setup evidence even when the token is expired; do not refresh or probe it.
			savedAuthProviders: fs.existsSync(getQwenCachedCredentialPath(apiConfiguration.qwenCodeOauthPath))
				? ["qwen-code"]
				: [],
		}),
	}
}
