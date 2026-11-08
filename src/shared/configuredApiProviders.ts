import type { ApiConfiguration } from "./api"
import { ALL_PROVIDERS, type ApiProvider } from "./api/providerNames"
import { ProviderToApiKeyMap, ProviderToBaseUrlKeyMap } from "./storage/provider-keys"

export interface ConfiguredApiProvidersInput {
	/** Saved global setup, not the active task's effective configuration. */
	apiConfiguration: ApiConfiguration
	/** Explicit additions for providers whose setup can be empty/keyless. */
	addedApiProviders?: readonly ApiProvider[]
	/** Credential-presence evidence supplied by a secret-redacted caller. */
	configuredApiKeys?: Partial<Record<ApiProvider, boolean>>
	/** Saved authentication evidence, irrespective of token expiry/refresh success. */
	savedAuthProviders?: readonly ApiProvider[]
}

/**
 * Project membership from existing setup storage without checking connectivity or authentication validity.
 * Selection defaults alone are not setup evidence. Legacy keyless selections are retained because their
 * setup may legitimately have no stored fields; new keyless additions use addedApiProviders.
 */
export function getConfiguredApiProviders({
	apiConfiguration: config,
	addedApiProviders = [],
	configuredApiKeys = {},
	savedAuthProviders = [],
}: ConfiguredApiProvidersInput): ApiProvider[] {
	const configured = new Set<ApiProvider>([...addedApiProviders, ...savedAuthProviders])
	for (const provider of ALL_PROVIDERS) {
		// Qwen Code reads its OAuth file, not the Qwen API key used by the direct integration.
		const keyNames = provider === "qwen-code" ? undefined : ProviderToApiKeyMap[provider]
		const keys = Array.isArray(keyNames) ? keyNames : keyNames ? [keyNames] : []
		const baseUrlKey = ProviderToBaseUrlKeyMap[provider]
		if (
			configuredApiKeys[provider] ||
			keys.some((key) => hasSavedValue(config[key])) ||
			(baseUrlKey && hasSavedValue(config[baseUrlKey as keyof ApiConfiguration]))
		) configured.add(provider)
	}

	if (config.openAiCompatibleProfiles?.length) configured.add("openai")
	if (hasSavedValue(config["openai-codex-oauth-credentials"])) configured.add("openai-codex")
	if (hasSavedValue(config["github-copilot-oauth-credentials"])) configured.add("github-copilot")
	if (hasSavedValue(config.claudeCodePath)) configured.add("claude-code")
	if (hasSavedValue(config.qwenCodeOauthPath)) configured.add("qwen-code")
	if (hasSavedValue(config.vertexProjectId) || hasSavedValue(config.vertexRegion)) configured.add("vertex")
	if (
		hasSavedValue(config.awsProfile) || hasSavedValue(config.awsRegion) ||
		hasSavedValue(config.awsAuthentication) || config.awsUseProfile === true
	) configured.add("bedrock")
	if (config.planModeVsCodeLmModelSelector || config.actModeVsCodeLmModelSelector) configured.add("vscode-lm")

	for (const provider of getLegacyKeylessApiProviders(config)) configured.add(provider)
	return ALL_PROVIDERS.filter((provider) => configured.has(provider))
}

const LEGACY_KEYLESS_PROVIDERS = new Set<ApiProvider>([
	"bedrock", "claude-code", "qwen-code", "lmstudio", "litellm", "vscode-lm",
])

/** Capture before selection changes; these integrations can have no saved access fields. */
export function getLegacyKeylessApiProviders(config: ApiConfiguration): ApiProvider[] {
	const selected = new Set([config.planModeApiProvider, config.actModeApiProvider])
	return ALL_PROVIDERS.filter((provider) => selected.has(provider) && LEGACY_KEYLESS_PROVIDERS.has(provider))
}

function hasSavedValue(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0
}
