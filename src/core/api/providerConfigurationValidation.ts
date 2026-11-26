import { type ApiConfiguration, type ApiProvider, modelSupportsInferenceSpeed, providerSupportsInferenceSpeed } from "@shared/api"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { type InferenceSpeed, isInferenceSpeed, type Mode } from "@shared/storage/types"
import { ApiConfigurationError, ApiConfigurationErrorCode } from "./ApiConfigurationError"

export function assertInferenceSpeedSupported(provider: ApiProvider, modelId: string | undefined, speed: InferenceSpeed | undefined): void {
	if (speed !== undefined && !isInferenceSpeed(speed)) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.ProviderConfigurationIncomplete,
			`Invalid inference speed: ${String(speed)}`,
			"Select Default, Standard, or Fast before retrying.",
		)
	}
	if (speed === "standard" && !providerSupportsInferenceSpeed(provider)) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.ModelUnavailable,
			`Provider ${provider} does not support inference speed controls`,
			"Reset inference speed to Default before retrying.",
		)
	}
	if (speed === "fast" && (!modelId || !modelSupportsInferenceSpeed(provider, modelId))) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.ModelUnavailable,
			`Model ${modelId || "(unconfigured)"} does not support Fast mode`,
			"Select a Fast-capable model or reset inference speed to Default.",
		)
	}
}

function assertOpenAiProfileExists(configuration: ApiConfiguration, mode: Mode): void {
	const name = mode === "plan" ? configuration.planModeOpenAiProfileName : configuration.actModeOpenAiProfileName
	if (!name || configuration.openAiCompatibleProfiles?.some((profile) => profile.name === name)) return
	throw new ApiConfigurationError(
		ApiConfigurationErrorCode.ProfileMissing,
		`OpenAI-compatible profile not found: ${name}`,
		"Select an available profile before retrying.",
	)
}

function assertDifyConnectionConfigured(configuration: ApiConfiguration): void {
	if (configuration.difyApiKey && configuration.difyBaseUrl) return
	throw new ApiConfigurationError(
		ApiConfigurationErrorCode.ProviderConfigurationIncomplete,
		"Dify requires both an API key and base URL",
		"Configure both values before selecting Dify.",
	)
}

type ProviderRule = {
	checkConnection?: (configuration: ApiConfiguration, mode: Mode) => void
	explicitModel?: { allowClearedInSettings: boolean }
}

const requiredModel = { allowClearedInSettings: false }
const providerRules: Partial<Record<ApiProvider, ProviderRule>> = {
	openai: { checkConnection: assertOpenAiProfileExists },
	dify: { checkConnection: assertDifyConnectionConfigured },
	openrouter: { explicitModel: { allowClearedInSettings: true } },
	together: { explicitModel: requiredModel },
	"vercel-ai-gateway": { explicitModel: requiredModel },
	aihubmix: { explicitModel: requiredModel },
}

export function assertProviderPrerequisites(provider: ApiProvider, configuration: ApiConfiguration, mode: Mode): void {
	providerRules[provider]?.checkConnection?.(configuration, mode)
}

export function assertRequiredModelSelected(
	provider: ApiProvider,
	configuration: ApiConfiguration,
	mode: Mode,
	{ editingSettings }: { editingSettings: boolean },
): void {
	const rule = providerRules[provider]?.explicitModel
	if (!rule) return
	const modelId = configuration[getProviderModelIdKey(provider, mode)]
	if (modelId || (editingSettings && rule.allowClearedInSettings && modelId === "")) return
	throw new ApiConfigurationError(
		ApiConfigurationErrorCode.ModelUnavailable,
		`${provider} requires an explicit model ID`,
		"Select a model before retrying.",
	)
}
