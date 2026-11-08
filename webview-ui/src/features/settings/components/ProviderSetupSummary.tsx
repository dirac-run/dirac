import type { ApiConfiguration, ApiProvider } from "@shared/api"
import { ProviderToApiKeyMap, ProviderToBaseUrlKeyMap } from "@shared/storage/provider-keys"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { useOpenRouterKeyInfo } from "@/shared/ui/hooks/useOpenRouterKeyInfo"

function OpenRouterUsage({ apiKey }: { apiKey: string }) {
	const { data } = useOpenRouterKeyInfo(apiKey)
	return data?.limit != null ? <span>Balance: ${(data.limit - data.usage).toFixed(2)}</span> : null
}

export function ProviderSetupSummary({ provider }: { provider: ApiProvider }) {
	const store = useSettingsStore()
	const config: ApiConfiguration = store.apiConfiguration
	const keyField = ProviderToApiKeyMap[provider]
	const keys = Array.isArray(keyField) ? keyField : keyField ? [keyField] : []
	const hasKey = keys.some((key) => !!config[key]) || store.remoteConfigSettings?.configuredApiKeys?.[provider]
	const urlField = ProviderToBaseUrlKeyMap[provider]
	const url = urlField ? config[urlField as keyof ApiConfiguration] : undefined
	const account = provider === "openai-codex" ? store.openAiCodexEmail : provider === "github-copilot" ? store.githubCopilotEmail : undefined
	const detail = provider === "bedrock" ? `AWS ${config.awsAuthentication ?? "default credentials"}${config.awsRegion ? ` · ${config.awsRegion}` : ""}`
		: provider === "vertex" ? `${config.vertexProjectId ?? "Google credentials"} · ${config.vertexRegion ?? "default region"}`
		: account ?? (hasKey ? "API key saved" : "Setup saved")
	return <span className="flex flex-wrap gap-2 text-xs text-description">
		<span>{detail}</span>{typeof url === "string" && <span>{url}</span>}
		{provider === "openrouter" && config.openRouterApiKey && <OpenRouterUsage apiKey={config.openRouterApiKey} />}
		{provider === "openai-codex" && store.openAiCodexUsage?.rateLimits.map((bucket) => bucket.primary && <span key={bucket.limitId}>{bucket.limitName ?? bucket.limitId}: {bucket.primary.usedPercent}% used</span>)}
	</span>
}
