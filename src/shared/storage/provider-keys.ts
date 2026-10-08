// Map providers to their specific model ID keys

import { Secrets, SettingsKey } from "@shared/storage/state-keys"
import {
	ApiProvider,
	anthropicDefaultModelId,
	basetenDefaultModelId,
	bedrockDefaultModelId,
	deepSeekDefaultModelId,
	fireworksDefaultModelId,
	geminiDefaultModelId,
	groqDefaultModelId,
	huaweiCloudMaasDefaultModelId,
	huggingFaceDefaultModelId,
	internationalQwenDefaultModelId,
	liteLlmDefaultModelId,
	minimaxDefaultModelId,
	moonshotDefaultModelId,
	nousResearchDefaultModelId,
	openAiNativeDefaultModelId,
	requestyDefaultModelId,
	unbiasedDefaultModelId,
	wandbDefaultModelId,
	xaiDefaultModelId,
} from "../api"

const ProviderKeyMap: Partial<Record<ApiProvider, string>> = {
	openrouter: "OpenRouterModelId",
	openai: "OpenAiModelId",
	lmstudio: "LmStudioModelId",
	litellm: "LiteLlmModelId",
	requesty: "RequestyModelId",
	together: "TogetherModelId",
	fireworks: "FireworksModelId",
	groq: "GroqModelId",
	baseten: "BasetenModelId",
	huggingface: "HuggingFaceModelId",
	aihubmix: "AihubmixModelId",
	nousResearch: "NousResearchModelId",
	"vercel-ai-gateway": "VercelAiGatewayModelId",
} as const

const ProviderModelInfoKeyMap: Partial<Record<ApiProvider, string>> = {
	openrouter: "OpenRouterModelInfo",
	openai: "OpenAiModelInfo",
	litellm: "LiteLlmModelInfo",
	requesty: "RequestyModelInfo",
	groq: "GroqModelInfo",
	baseten: "BasetenModelInfo",
	huggingface: "HuggingFaceModelInfo",
	"huawei-cloud-maas": "HuaweiCloudMaasModelInfo",
	aihubmix: "AihubmixModelInfo",
	"vercel-ai-gateway": "VercelAiGatewayModelInfo",
} as const

export const ProviderToBaseUrlKeyMap: Partial<Record<ApiProvider, SettingsKey>> = {
	openai: "openAiBaseUrl",
	"openai-native": "openAiBaseUrl",
	litellm: "liteLlmBaseUrl",
	lmstudio: "lmStudioBaseUrl",
	anthropic: "anthropicBaseUrl",
	gemini: "geminiBaseUrl",
	requesty: "requestyBaseUrl",
	dify: "difyBaseUrl",
	aihubmix: "aihubmixBaseUrl",
	bedrock: "awsBedrockEndpoint",
} as const

export const ProviderToApiKeyMap: Partial<Record<ApiProvider, keyof Secrets | (keyof Secrets)[]>> = {
	anthropic: "apiKey",
	openrouter: "openRouterApiKey",
	bedrock: ["awsAccessKey", "awsBedrockApiKey"],
	openai: ["openAiApiKey", "openAiCompatibleCustomApiKey"],
	gemini: "geminiApiKey",
	"openai-native": "openAiNativeApiKey",
	requesty: "requestyApiKey",
	together: "togetherApiKey",
	deepseek: "deepSeekApiKey",
	unbiased: "unbiasedApiKey",
	qwen: "qwenApiKey",
	"qwen-code": "qwenApiKey",
	doubao: "doubaoApiKey",
	mistral: "mistralApiKey",
	litellm: "liteLlmApiKey",
	moonshot: "moonshotApiKey",
	nebius: "nebiusApiKey",
	atlascloud: "atlascloudApiKey",
	fireworks: "fireworksApiKey",
	xai: "xaiApiKey",
	sambanova: "sambanovaApiKey",
	cerebras: "cerebrasApiKey",
	groq: "groqApiKey",
	huggingface: "huggingFaceApiKey",
	"huawei-cloud-maas": "huaweiCloudMaasApiKey",
	dify: "difyApiKey",
	baseten: "basetenApiKey",
	"vercel-ai-gateway": "vercelAiGatewayApiKey",
	zai: "zaiApiKey",
	aihubmix: "aihubmixApiKey",
	minimax: "minimaxApiKey",
	nousResearch: "nousResearchApiKey",
	wandb: "wandbApiKey",
} as const

const ProviderDefaultModelMap: Partial<Record<ApiProvider, string>> = {
	anthropic: anthropicDefaultModelId,
	openai: openAiNativeDefaultModelId,
	lmstudio: "",
	litellm: liteLlmDefaultModelId,
	requesty: requestyDefaultModelId,
	fireworks: fireworksDefaultModelId,
	groq: groqDefaultModelId,
	baseten: basetenDefaultModelId,
	huggingface: huggingFaceDefaultModelId,
	"huawei-cloud-maas": huaweiCloudMaasDefaultModelId,
	bedrock: bedrockDefaultModelId,
	nousResearch: nousResearchDefaultModelId,
	xai: xaiDefaultModelId,
	gemini: geminiDefaultModelId,
	minimax: minimaxDefaultModelId,
	moonshot: moonshotDefaultModelId,
	qwen: internationalQwenDefaultModelId,
	deepseek: deepSeekDefaultModelId,
	unbiased: unbiasedDefaultModelId,
	wandb: wandbDefaultModelId,
} as const

/**
 * Get the provider-specific model ID key for a given provider and mode.
 * Different providers store their model IDs in different state keys.
 */
export function getProviderModelIdKey(provider: ApiProvider, mode: "act" | "plan"): SettingsKey {
	const keySuffix = ProviderKeyMap[provider]
	if (keySuffix) {
		// E.g. actModeOpenAiModelId, planModeOpenAiModelId, etc.
		return `${mode}Mode${keySuffix}` as SettingsKey
	}

	// For providers without a specific key (anthropic, gemini, bedrock, etc.),
	// they use the generic actModeApiModelId/planModeApiModelId
	return `${mode}ModeApiModelId`
}

export function getProviderModelInfoKey(provider: ApiProvider, mode: "act" | "plan"): SettingsKey | undefined {
	const keySuffix = ProviderModelInfoKeyMap[provider]
	return keySuffix ? (`${mode}Mode${keySuffix}` as SettingsKey) : undefined
}

export function getProviderDefaultModelId(provider: ApiProvider): string | null {
	return ProviderDefaultModelMap[provider] || ""
}
