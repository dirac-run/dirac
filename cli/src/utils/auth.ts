import * as fs from "node:fs"
import { getQwenCachedCredentialPath } from "@/utils/qwenCodeCredentialPath"
import type { ApiConfiguration, ApiProvider } from "@shared/api"
import { ProviderToApiKeyMap } from "@shared/storage"
import { getSecretsFromEnv } from "@shared/storage/env-config"
import type { Mode } from "@shared/storage/types"
import { StateManager } from "@/core/storage/StateManager"
import { isValidCliProvider } from "./providers.js"

/**
 * Check if the user has completed onboarding (has any provider configured).
 *
 * Uses `welcomeViewCompleted` as the single source of truth, matching the VS Code extension's approach.
 * If `welcomeViewCompleted` is undefined (first run), checks if ANY provider has credentials
 * and sets the flag accordingly.
 */
export async function isAuthConfigured(): Promise<boolean> {
	// Check environment variables first - they always count as "configured"
	const envSecrets = getSecretsFromEnv()
	if (Object.keys(envSecrets).length > 0) return true

	const stateManager = StateManager.get()

	// Check welcomeViewCompleted first - this is the single source of truth
	const welcomeViewCompleted = stateManager.getGlobalStateKey("welcomeViewCompleted")
	if (welcomeViewCompleted !== undefined) {
		return welcomeViewCompleted
	}

	// welcomeViewCompleted is undefined - run migration logic to check if ANY provider has credentials
	// This mirrors the extension's migrateWelcomeViewCompleted behavior
	const hasAnyAuth = await checkAnyProviderConfigured()

	// Set welcomeViewCompleted based on what we found
	stateManager.setGlobalState("welcomeViewCompleted", hasAnyAuth)
	await stateManager.flushPendingState()

	return hasAnyAuth
}

function selectedProvider(configuration: ApiConfiguration, mode: Mode): ApiProvider | undefined {
	return (mode === "plan" ? configuration.planModeApiProvider : configuration.actModeApiProvider) ?? configuration.apiProvider
}

/** Whether the provider selected for a new ACP session has coherent credentials and settings. */
export function isSelectedProviderConfigured(configuration: ApiConfiguration, mode: Mode): boolean {
	const provider = selectedProvider(configuration, mode)
	if (!provider || !isValidCliProvider(provider)) return false

	if (provider === "openai") {
		const profileName = mode === "plan" ? configuration.planModeOpenAiProfileName : configuration.actModeOpenAiProfileName
		if (profileName) {
			const profile = configuration.openAiCompatibleProfiles?.find((candidate) => candidate.name === profileName)
			return Boolean(profile && (profile.apiKey || configuration.openAiCompatibleCustomApiKey))
		}
		return Boolean(configuration.openAiCompatibleCustomApiKey || configuration.openAiApiKey)
	}
	if (provider === "dify" && (!configuration.difyApiKey || !configuration.difyBaseUrl)) return false
	const dynamicModelId =
		provider === "openrouter"
			? mode === "plan"
				? configuration.planModeOpenRouterModelId
				: configuration.actModeOpenRouterModelId
			: provider === "together"
				? mode === "plan"
					? configuration.planModeTogetherModelId
					: configuration.actModeTogetherModelId
				: provider === "vercel-ai-gateway"
					? mode === "plan"
						? configuration.planModeVercelAiGatewayModelId
						: configuration.actModeVercelAiGatewayModelId
					: provider === "aihubmix"
						? mode === "plan"
							? configuration.planModeAihubmixModelId
							: configuration.actModeAihubmixModelId
						: undefined
	if (["openrouter", "together", "vercel-ai-gateway", "aihubmix"].includes(provider) && !dynamicModelId) return false

	if (provider === "openai-codex") return Boolean(configuration["openai-codex-oauth-credentials"])
	if (provider === "github-copilot") return Boolean(configuration["github-copilot-oauth-credentials"])
	if (provider === "qwen-code") return fs.existsSync(getQwenCachedCredentialPath(configuration.qwenCodeOauthPath))
	if (provider === "vertex") return Boolean(configuration.vertexProjectId || configuration.geminiApiKey)
	if (provider === "lmstudio") return Boolean(configuration.lmStudioBaseUrl)
	if (provider === "bedrock") {
		return Boolean(
			configuration.awsBedrockApiKey ||
			(configuration.awsAccessKey && configuration.awsSecretKey) ||
			(configuration.awsUseProfile && configuration.awsProfile) ||
			configuration.awsRegion,
		)
	}
	if (provider === "claude-code") return true

	const keyField = ProviderToApiKeyMap[provider]
	if (!keyField) return true
	const fields = Array.isArray(keyField) ? keyField : [keyField]
	return fields.some((field) => Boolean(configuration[field]))
}

/**
 * Check if ANY provider has valid credentials configured.
 * Used for migration when welcomeViewCompleted is undefined.
 */
export async function checkAnyProviderConfigured(): Promise<boolean> {
	// Check environment variables first
	const envSecrets = getSecretsFromEnv()
	if (Object.keys(envSecrets).length > 0) return true

	const stateManager = StateManager.get()
	const config = stateManager.getApiConfiguration() as Record<string, unknown>

	// A signed-in Dirac account counts as completed onboarding even though it is not an API provider.
	if (config["dirac:diracAccountId"]) return true

	// Check OpenAI Codex OAuth (stored in SECRETS_KEYS, loaded into config)
	if (config["openai-codex-oauth-credentials"]) return true

	// Qwen Code shares the official CLI's subscription cache; no API key is used.
	if (fs.existsSync(getQwenCachedCredentialPath(config.qwenCodeOauthPath as string | undefined))) return true

	// Check all BYO provider API keys (loaded into config from secrets)
	for (const [provider, keyField] of Object.entries(ProviderToApiKeyMap)) {
		const fields = Array.isArray(keyField) ? keyField : [keyField]
		for (const field of fields) {
			if (config[field]) return true
		}
	}

	// Check provider-specific settings that indicate configuration
	// (for providers that don't require API keys like Bedrock with IAM, LM Studio)
	if (config.awsRegion) return true
	if (config.vertexProjectId) return true
	if (config.lmStudioBaseUrl) return true

	return false
}
