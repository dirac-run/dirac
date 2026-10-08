import {
	LiteLLMModelInfo,
	OpenAiCompatibleModelInfo,
	OpenAiCompatibleProfile,
	OpenRouterModelInfo,
	ModelsApiConfiguration as ProtoApiConfiguration,
	ApiProvider as ProtoApiProvider,
	OcaModelInfo as ProtoOcaModelInfo,
	ThinkingConfig,
} from "@shared/proto/dirac/models"
import type { ModelProviderSelection as ProtoModelProviderSelection } from "@shared/proto/dirac/state"
import {
	ApiConfiguration,
	ApiProvider,
	LiteLLMModelInfo as AppLiteLLMModelInfo,
	ModelProviderSelection as AppModelProviderSelection,
	OpenAiCompatibleModelInfo as AppOpenAiCompatibleModelInfo,
	OpenAiCompatibleProfile as AppOpenAiCompatibleProfile,
	BedrockModelId,
	ModelInfo,
	OcaModelInfo,
	openAiModelInfoSaneDefaults,
} from "../../api"
import { isOpenaiReasoningEffort, normalizeInferenceSpeed, type OpenaiReasoningEffort } from "../../storage/types"

function parseReasoningEffortOptions(values: readonly string[]): OpenaiReasoningEffort[] | undefined {
	const options = values.filter(isOpenaiReasoningEffort)
	return options.length > 0 ? options : undefined
}

function parseReasoningEffort(value: string | undefined): OpenaiReasoningEffort | undefined {
	return isOpenaiReasoningEffort(value) ? value : undefined
}

// Convert application ThinkingConfig to proto ThinkingConfig
function convertThinkingConfigToProto(config: ModelInfo["thinkingConfig"]): ThinkingConfig | undefined {
	if (!config) {
		return undefined
	}

	return {
		maxBudget: config.maxBudget,
		outputPrice: config.outputPrice,
		outputPriceTiers: config.outputPriceTiers || [], // Provide empty array if undefined
	}
}

function convertStringArrayMapToProto(value: Record<string, string[]> | undefined) {
	return Object.fromEntries(Object.entries(value || {}).map(([key, values]) => [key, { values }]))
}

function convertProtoToStringArrayMap(
	value: Record<string, { values: string[] }> | undefined,
): Record<string, string[]> | undefined {
	if (!value || Object.keys(value).length === 0) return undefined
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item.values]))
}

// Convert proto ThinkingConfig to application ThinkingConfig
function convertProtoToThinkingConfig(config: ThinkingConfig | undefined): ModelInfo["thinkingConfig"] | undefined {
	if (!config) {
		return undefined
	}

	return {
		maxBudget: config.maxBudget,
		outputPrice: config.outputPrice,
		outputPriceTiers: config.outputPriceTiers.length > 0 ? config.outputPriceTiers : undefined,
	}
}

// Convert application ModelInfo to proto OpenRouterModelInfo
function convertModelInfoToProtoOpenRouter(info: ModelInfo | undefined): OpenRouterModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache ?? false,
		supportsReasoning: info.supportsReasoning,
		supportsReasoningEffort: info.supportsReasoningEffort,
		reasoningEffortOptions: info.reasoningEffortOptions || [],
		defaultReasoningEffort: info.defaultReasoningEffort,
		supportsFastMode: info.supportsFastMode,
		fastModePriceMultiplier: info.fastModePriceMultiplier,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		thinkingConfig: convertThinkingConfigToProto(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		tiers: info.tiers || [],
	}
}

// Convert proto OpenRouterModelInfo to application ModelInfo
function convertProtoToModelInfo(info: OpenRouterModelInfo | undefined): ModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache,
		supportsReasoning: info.supportsReasoning,
		supportsReasoningEffort: info.supportsReasoningEffort,
		reasoningEffortOptions: parseReasoningEffortOptions(info.reasoningEffortOptions),
		defaultReasoningEffort: parseReasoningEffort(info.defaultReasoningEffort),
		supportsFastMode: info.supportsFastMode,
		fastModePriceMultiplier: info.fastModePriceMultiplier,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		thinkingConfig: convertProtoToThinkingConfig(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		tiers: info.tiers.length > 0 ? info.tiers : undefined,
	}
}

// Convert application ModelInfo to proto OcaModelInfo
function convertOcaModelInfoToProtoOcaModelInfo(info: OcaModelInfo | undefined): ProtoOcaModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache ?? false,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		thinkingConfig: convertThinkingConfigToProto(info.thinkingConfig),
		surveyContent: info.surveyContent,
		surveyId: info.surveyId,
		banner: info.banner,
		modelName: info.modelName,
		apiFormat: info.apiFormat,
		supportsReasoning: info.supportsReasoning,
		reasoningEffortOptions: parseReasoningEffortOptions(info.reasoningEffortOptions) || [],
	}
}

// Convert proto OpenRouterModelInfo to application ModelInfo
function convertProtoOcaModelInfoToOcaModelInfo(info: ProtoOcaModelInfo | undefined): OcaModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		surveyContent: info.surveyContent,
		surveyId: info.surveyId,
		banner: info.banner,
		modelName: info.modelName,
		apiFormat: info.apiFormat,
		supportsReasoning: info.supportsReasoning,
		reasoningEffortOptions: parseReasoningEffortOptions(info.reasoningEffortOptions) || [],
	}
}

// Convert application LiteLLMModelInfo to proto LiteLLMModelInfo
function convertLiteLLMModelInfoToProto(info: AppLiteLLMModelInfo | undefined): LiteLLMModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache ?? false,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		thinkingConfig: convertThinkingConfigToProto(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		tiers: info.tiers || [],
		temperature: info.temperature,
		supportsReasoning: info.supportsReasoning,
	}
}

// Convert proto LiteLLMModelInfo to application LiteLLMModelInfo
function convertProtoToLiteLLMModelInfo(info: LiteLLMModelInfo | undefined): AppLiteLLMModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		thinkingConfig: convertProtoToThinkingConfig(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		tiers: info.tiers.length > 0 ? info.tiers : undefined,
		temperature: info.temperature,
		supportsReasoning: info.supportsReasoning,
	}
}

// Convert application OpenAiCompatibleModelInfo to proto OpenAiCompatibleModelInfo
function convertOpenAiCompatibleModelInfoToProto(
	info: AppOpenAiCompatibleModelInfo | undefined,
): OpenAiCompatibleModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache ?? false,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		thinkingConfig: convertThinkingConfigToProto(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		description: info.description,
		tiers: info.tiers || [],
		temperature: info.temperature,
		isR1FormatRequired: info.isR1FormatRequired,
		supportsFastMode: info.supportsFastMode,
		fastModePriceMultiplier: info.fastModePriceMultiplier,
	}
}

// Convert proto OpenAiCompatibleModelInfo to application OpenAiCompatibleModelInfo
// Convert application OpenAiCompatibleProfile to proto OpenAiCompatibleProfile
function convertOpenAiCompatibleProfileToProto(profile: AppOpenAiCompatibleProfile): OpenAiCompatibleProfile {
	return {
		name: profile.name,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		modelId: profile.modelId,
		modelInfo: convertOpenAiCompatibleModelInfoToProto(profile.modelInfo),
		headers: profile.headers || {},
		azureApiVersion: profile.azureApiVersion,
	}
}

// Convert proto OpenAiCompatibleProfile to application OpenAiCompatibleProfile
function convertProtoToOpenAiCompatibleProfile(profile: OpenAiCompatibleProfile): AppOpenAiCompatibleProfile {
	return {
		name: profile.name,
		baseUrl: profile.baseUrl,
		apiKey: profile.apiKey,
		modelId: profile.modelId,
		modelInfo: convertProtoToOpenAiCompatibleModelInfo(profile.modelInfo) || openAiModelInfoSaneDefaults,
		headers: Object.keys(profile.headers || {}).length > 0 ? profile.headers : undefined,
		azureApiVersion: profile.azureApiVersion,
	}
}

function convertProtoToOpenAiCompatibleModelInfo(
	info: OpenAiCompatibleModelInfo | undefined,
): AppOpenAiCompatibleModelInfo | undefined {
	if (!info) {
		return undefined
	}

	return {
		maxTokens: info.maxTokens,
		contextWindow: info.contextWindow,
		supportsImages: info.supportsImages,
		supportsPromptCache: info.supportsPromptCache,
		inputPrice: info.inputPrice,
		outputPrice: info.outputPrice,
		thinkingConfig: convertProtoToThinkingConfig(info.thinkingConfig),
		supportsGlobalEndpoint: info.supportsGlobalEndpoint,
		cacheWritesPrice: info.cacheWritesPrice,
		cacheReadsPrice: info.cacheReadsPrice,
		supportsFastMode: info.supportsFastMode,
		fastModePriceMultiplier: info.fastModePriceMultiplier,
		description: info.description,
		tiers: info.tiers.length > 0 ? info.tiers : undefined,
		temperature: info.temperature,
		isR1FormatRequired: info.isR1FormatRequired,
	}
}

// Convert application ApiProvider to proto ApiProvider
export function convertApiProviderToProto(provider: ApiProvider | undefined): ProtoApiProvider {
	if (provider === undefined) return ProtoApiProvider.ANTHROPIC

	switch (provider) {
		case "anthropic":
			return ProtoApiProvider.ANTHROPIC
		case "openrouter":
			return ProtoApiProvider.OPENROUTER
		case "bedrock":
			return ProtoApiProvider.BEDROCK
		case "vertex":
			return ProtoApiProvider.VERTEX
		case "openai":
			return ProtoApiProvider.OPENAI
		case "lmstudio":
			return ProtoApiProvider.LMSTUDIO
		case "gemini":
			return ProtoApiProvider.GEMINI
		case "openai-native":
			return ProtoApiProvider.OPENAI_NATIVE
		case "requesty":
			return ProtoApiProvider.REQUESTY
		case "together":
			return ProtoApiProvider.TOGETHER
		case "deepseek":
			return ProtoApiProvider.DEEPSEEK
		case "unbiased":
			return ProtoApiProvider.UNBIASED
		case "qwen":
			return ProtoApiProvider.QWEN
		case "qwen-code":
			return ProtoApiProvider.QWEN_CODE
		case "doubao":
			return ProtoApiProvider.DOUBAO
		case "mistral":
			return ProtoApiProvider.MISTRAL
		case "github-copilot":
			return ProtoApiProvider.GITHUB_COPILOT
		case "vscode-lm":
			return ProtoApiProvider.VSCODE_LM
		case "litellm":
			return ProtoApiProvider.LITELLM
		case "moonshot":
			return ProtoApiProvider.MOONSHOT
		case "huggingface":
			return ProtoApiProvider.HUGGINGFACE
		case "nebius":
			return ProtoApiProvider.NEBIUS
		case "atlascloud":
			return ProtoApiProvider.ATLASCLOUD
		case "wandb":
			return ProtoApiProvider.WANDB
		case "fireworks":
			return ProtoApiProvider.FIREWORKS
		case "xai":
			return ProtoApiProvider.XAI
		case "sambanova":
			return ProtoApiProvider.SAMBANOVA
		case "cerebras":
			return ProtoApiProvider.CEREBRAS
		case "groq":
			return ProtoApiProvider.GROQ
		case "baseten":
			return ProtoApiProvider.BASETEN
		case "claude-code":
			return ProtoApiProvider.CLAUDE_CODE
		case "huawei-cloud-maas":
			return ProtoApiProvider.HUAWEI_CLOUD_MAAS
		case "vercel-ai-gateway":
			return ProtoApiProvider.VERCEL_AI_GATEWAY
		case "zai":
			return ProtoApiProvider.ZAI
		case "oca":
			return ProtoApiProvider.OCA
		case "dify":
			return ProtoApiProvider.DIFY
		case "aihubmix":
			return ProtoApiProvider.AIHUBMIX
		case "minimax":
			return ProtoApiProvider.MINIMAX
		case "nousResearch":
			return ProtoApiProvider.NOUSRESEARCH
		case "openai-codex":
			return ProtoApiProvider.OPENAI_CODEX
	}
	throw new Error(`Unsupported API provider: ${provider}`)
}

export function convertModelProviderSelectionToProto(selection: AppModelProviderSelection): ProtoModelProviderSelection {
	return {
		provider: convertApiProviderToProto(selection.provider),
		modelId: selection.modelId,
		modelInfo: convertModelInfoToProtoOpenRouter(selection.modelInfo),
		openAiProfileName: selection.openAiProfileName,
		vsCodeLmModelSelector: selection.vsCodeLmModelSelector,
		awsBedrockCustomSelected: selection.awsBedrockCustomSelected,
		awsBedrockCustomModelBaseId: selection.awsBedrockCustomModelBaseId,
	}
}

export function convertProtoToModelProviderSelection(selection: ProtoModelProviderSelection): AppModelProviderSelection {
	return {
		provider: convertProtoToApiProvider(selection.provider),
		modelId: selection.modelId,
		modelInfo: convertProtoToModelInfo(selection.modelInfo),
		openAiProfileName: selection.openAiProfileName,
		vsCodeLmModelSelector: selection.vsCodeLmModelSelector,
		awsBedrockCustomSelected: selection.awsBedrockCustomSelected,
		awsBedrockCustomModelBaseId: selection.awsBedrockCustomModelBaseId,
	}
}

// Convert proto ApiProvider to application ApiProvider
export function convertProtoToApiProvider(provider: ProtoApiProvider): ApiProvider {
	switch (provider) {
		case ProtoApiProvider.ANTHROPIC:
			return "anthropic"
		case ProtoApiProvider.OPENROUTER:
			return "openrouter"
		case ProtoApiProvider.BEDROCK:
			return "bedrock"
		case ProtoApiProvider.VERTEX:
			return "vertex"
		case ProtoApiProvider.OPENAI:
			return "openai"
		case ProtoApiProvider.LMSTUDIO:
			return "lmstudio"
		case ProtoApiProvider.GEMINI:
			return "gemini"
		case ProtoApiProvider.OPENAI_NATIVE:
			return "openai-native"
		case ProtoApiProvider.REQUESTY:
			return "requesty"
		case ProtoApiProvider.TOGETHER:
			return "together"
		case ProtoApiProvider.DEEPSEEK:
			return "deepseek"
		case ProtoApiProvider.UNBIASED:
			return "unbiased"
		case ProtoApiProvider.QWEN:
			return "qwen"
		case ProtoApiProvider.QWEN_CODE:
			return "qwen-code"
		case ProtoApiProvider.DOUBAO:
			return "doubao"
		case ProtoApiProvider.MISTRAL:
			return "mistral"
		case ProtoApiProvider.GITHUB_COPILOT:
			return "github-copilot"
		case ProtoApiProvider.VSCODE_LM:
			return "vscode-lm"
		case ProtoApiProvider.LITELLM:
			return "litellm"
		case ProtoApiProvider.MOONSHOT:
			return "moonshot"
		case ProtoApiProvider.HUGGINGFACE:
			return "huggingface"
		case ProtoApiProvider.NEBIUS:
			return "nebius"
		case ProtoApiProvider.ATLASCLOUD:
			return "atlascloud"
		case ProtoApiProvider.WANDB:
			return "wandb"
		case ProtoApiProvider.FIREWORKS:
			return "fireworks"
		case ProtoApiProvider.XAI:
			return "xai"
		case ProtoApiProvider.SAMBANOVA:
			return "sambanova"
		case ProtoApiProvider.CEREBRAS:
			return "cerebras"
		case ProtoApiProvider.GROQ:
			return "groq"
		case ProtoApiProvider.BASETEN:
			return "baseten"
		case ProtoApiProvider.CLAUDE_CODE:
			return "claude-code"
		case ProtoApiProvider.HUAWEI_CLOUD_MAAS:
			return "huawei-cloud-maas"
		case ProtoApiProvider.VERCEL_AI_GATEWAY:
			return "vercel-ai-gateway"
		case ProtoApiProvider.ZAI:
			return "zai"
		case ProtoApiProvider.OCA:
			return "oca"
		case ProtoApiProvider.DIFY:
			return "dify"
		case ProtoApiProvider.AIHUBMIX:
			return "aihubmix"
		case ProtoApiProvider.MINIMAX:
			return "minimax"
		case ProtoApiProvider.NOUSRESEARCH:
			return "nousResearch"
		case ProtoApiProvider.OPENAI_CODEX:
			return "openai-codex"
		case ProtoApiProvider.UNRECOGNIZED:
			throw new Error("Unrecognized API provider value")
	}
	throw new Error(`Unsupported protobuf API provider: ${provider}`)
}

// Converts application ApiConfiguration to proto ApiConfiguration
export function convertApiConfigurationToProto(config: ApiConfiguration): ProtoApiConfiguration {
	return {
		// Global configuration fields
		apiKey: config.apiKey,
		ulid: config.ulid,
		liteLlmBaseUrl: config.liteLlmBaseUrl,
		liteLlmApiKey: config.liteLlmApiKey,
		liteLlmUsePromptCache: config.liteLlmUsePromptCache,
		openAiHeaders: config.openAiHeaders || {},
		anthropicBaseUrl: config.anthropicBaseUrl,
		openRouterApiKey: config.openRouterApiKey,
		openRouterProviderSorting: config.openRouterProviderSorting,
		openRouterPinnedProviders: convertStringArrayMapToProto(config.openRouterPinnedProviders),
		openRouterPreventFallbacks: config.openRouterPreventFallbacks,
		awsAccessKey: config.awsAccessKey,
		awsSecretKey: config.awsSecretKey,
		awsSessionToken: config.awsSessionToken,
		awsRegion: config.awsRegion,
		awsUseCrossRegionInference: config.awsUseCrossRegionInference,
		awsUseGlobalInference: config.awsUseGlobalInference,
		awsBedrockUsePromptCache: config.awsBedrockUsePromptCache,
		awsUseProfile: config.awsUseProfile,
		awsAuthentication: config.awsAuthentication,
		awsProfile: config.awsProfile,
		awsBedrockApiKey: config.awsBedrockApiKey,
		awsBedrockEndpoint: config.awsBedrockEndpoint,
		claudeCodePath: config.claudeCodePath,
		vertexProjectId: config.vertexProjectId,
		vertexRegion: config.vertexRegion,
		openAiBaseUrl: config.openAiBaseUrl,
		openAiApiKey: config.openAiApiKey,
		lmStudioBaseUrl: config.lmStudioBaseUrl,
		lmStudioMaxTokens: config.lmStudioMaxTokens,
		geminiApiKey: config.geminiApiKey,
		geminiBaseUrl: config.geminiBaseUrl,
		openAiNativeApiKey: config.openAiNativeApiKey,
		deepSeekApiKey: config.deepSeekApiKey,
		unbiasedApiKey: config.unbiasedApiKey,
		requestyApiKey: config.requestyApiKey,
		requestyBaseUrl: config.requestyBaseUrl,
		togetherApiKey: config.togetherApiKey,
		fireworksApiKey: config.fireworksApiKey,
		fireworksModelMaxCompletionTokens: config.fireworksModelMaxCompletionTokens,
		fireworksModelMaxTokens: config.fireworksModelMaxTokens,
		qwenApiKey: config.qwenApiKey,
		qwenCodeOauthPath: config.qwenCodeOauthPath,
		doubaoApiKey: config.doubaoApiKey,
		mistralApiKey: config.mistralApiKey,
		azureApiVersion: config.azureApiVersion,
		qwenApiLine: config.qwenApiLine,
		moonshotApiLine: config.moonshotApiLine,
		moonshotApiKey: config.moonshotApiKey,
		huggingFaceApiKey: config.huggingFaceApiKey,
		nebiusApiKey: config.nebiusApiKey,
		atlascloudApiKey: config.atlascloudApiKey,
		wandbApiKey: config.wandbApiKey,
		xaiApiKey: config.xaiApiKey,
		sambanovaApiKey: config.sambanovaApiKey,
		cerebrasApiKey: config.cerebrasApiKey,
		vercelAiGatewayApiKey: config.vercelAiGatewayApiKey,
		groqApiKey: config.groqApiKey,
		basetenApiKey: config.basetenApiKey,
		requestTimeoutMs: config.requestTimeoutMs,
		huaweiCloudMaasApiKey: config.huaweiCloudMaasApiKey,
		zaiApiLine: config.zaiApiLine,
		zaiApiKey: config.zaiApiKey,
		difyApiKey: config.difyApiKey,
		difyBaseUrl: config.difyBaseUrl,
		minimaxApiKey: config.minimaxApiKey,
		minimaxApiLine: config.minimaxApiLine,
		nousResearchApiKey: config.nousResearchApiKey,
		aihubmixApiKey: config.aihubmixApiKey,
		aihubmixBaseUrl: config.aihubmixBaseUrl,
		aihubmixAppCode: config.aihubmixAppCode,
		openAiCompatibleProfiles: (config.openAiCompatibleProfiles || []).map(convertOpenAiCompatibleProfileToProto),

		// Plan mode configurations
		planModeApiProvider: config.planModeApiProvider ? convertApiProviderToProto(config.planModeApiProvider) : undefined,
		planModeApiModelId: config.planModeApiModelId,
		planModeThinkingBudgetTokens: config.planModeThinkingBudgetTokens,
		geminiPlanModeThinkingLevel: config.geminiPlanModeThinkingLevel,
		planModeReasoningEffort: config.planModeReasoningEffort,
		planModeInferenceSpeed: config.planModeInferenceSpeed,
		planModeVsCodeLmModelSelector: config.planModeVsCodeLmModelSelector,
		planModeAwsBedrockCustomSelected: config.planModeAwsBedrockCustomSelected,
		planModeAwsBedrockCustomModelBaseId: config.planModeAwsBedrockCustomModelBaseId as string | undefined,
		planModeOpenRouterModelId: config.planModeOpenRouterModelId,
		planModeOpenRouterModelInfo: convertModelInfoToProtoOpenRouter(config.planModeOpenRouterModelInfo),
		planModeOpenAiModelId: config.planModeOpenAiModelId,
		planModeOpenAiModelInfo: convertOpenAiCompatibleModelInfoToProto(config.planModeOpenAiModelInfo),
		planModeOpenAiProfileName: config.planModeOpenAiProfileName,
		planModeLmStudioModelId: config.planModeLmStudioModelId,
		planModeLiteLlmModelId: config.planModeLiteLlmModelId,
		planModeLiteLlmModelInfo: convertLiteLLMModelInfoToProto(config.planModeLiteLlmModelInfo),
		planModeRequestyModelId: config.planModeRequestyModelId,
		planModeRequestyModelInfo: convertModelInfoToProtoOpenRouter(config.planModeRequestyModelInfo),
		planModeTogetherModelId: config.planModeTogetherModelId,
		planModeFireworksModelId: config.planModeFireworksModelId,
		planModeGroqModelId: config.planModeGroqModelId,
		planModeGroqModelInfo: convertModelInfoToProtoOpenRouter(config.planModeGroqModelInfo),
		planModeBasetenModelId: config.planModeBasetenModelId,
		planModeBasetenModelInfo: convertModelInfoToProtoOpenRouter(config.planModeBasetenModelInfo),
		planModeHuggingFaceModelId: config.planModeHuggingFaceModelId,
		planModeHuggingFaceModelInfo: convertModelInfoToProtoOpenRouter(config.planModeHuggingFaceModelInfo),
		planModeHuaweiCloudMaasModelId: config.planModeHuaweiCloudMaasModelId,
		planModeHuaweiCloudMaasModelInfo: convertModelInfoToProtoOpenRouter(config.planModeHuaweiCloudMaasModelInfo),
		planModeAihubmixModelId: config.planModeAihubmixModelId,
		planModeAihubmixModelInfo: convertOpenAiCompatibleModelInfoToProto(config.planModeAihubmixModelInfo),
		planModeNousResearchModelId: config.planModeNousResearchModelId,
		planModeVercelAiGatewayModelId: config.planModeVercelAiGatewayModelId,
		planModeVercelAiGatewayModelInfo: convertModelInfoToProtoOpenRouter(config.planModeVercelAiGatewayModelInfo),

		// Act mode configurations
		actModeApiProvider: config.actModeApiProvider ? convertApiProviderToProto(config.actModeApiProvider) : undefined,
		actModeApiModelId: config.actModeApiModelId,
		actModeThinkingBudgetTokens: config.actModeThinkingBudgetTokens,
		geminiActModeThinkingLevel: config.geminiActModeThinkingLevel,
		actModeReasoningEffort: config.actModeReasoningEffort,
		actModeInferenceSpeed: config.actModeInferenceSpeed,
		actModeVsCodeLmModelSelector: config.actModeVsCodeLmModelSelector,
		actModeAwsBedrockCustomSelected: config.actModeAwsBedrockCustomSelected,
		actModeAwsBedrockCustomModelBaseId: config.actModeAwsBedrockCustomModelBaseId as string | undefined,
		actModeOpenRouterModelId: config.actModeOpenRouterModelId,
		actModeOpenRouterModelInfo: convertModelInfoToProtoOpenRouter(config.actModeOpenRouterModelInfo),
		actModeOpenAiModelId: config.actModeOpenAiModelId,
		actModeOpenAiModelInfo: convertOpenAiCompatibleModelInfoToProto(config.actModeOpenAiModelInfo),
		actModeLmStudioModelId: config.actModeLmStudioModelId,
		actModeLiteLlmModelId: config.actModeLiteLlmModelId,
		actModeLiteLlmModelInfo: convertLiteLLMModelInfoToProto(config.actModeLiteLlmModelInfo),
		actModeRequestyModelId: config.actModeRequestyModelId,
		actModeRequestyModelInfo: convertModelInfoToProtoOpenRouter(config.actModeRequestyModelInfo),
		actModeTogetherModelId: config.actModeTogetherModelId,
		actModeFireworksModelId: config.actModeFireworksModelId,
		actModeGroqModelId: config.actModeGroqModelId,
		actModeGroqModelInfo: convertModelInfoToProtoOpenRouter(config.actModeGroqModelInfo),
		actModeBasetenModelId: config.actModeBasetenModelId,
		actModeBasetenModelInfo: convertModelInfoToProtoOpenRouter(config.actModeBasetenModelInfo),
		actModeHuggingFaceModelId: config.actModeHuggingFaceModelId,
		actModeHuggingFaceModelInfo: convertModelInfoToProtoOpenRouter(config.actModeHuggingFaceModelInfo),
		actModeHuaweiCloudMaasModelId: config.actModeHuaweiCloudMaasModelId,
		actModeHuaweiCloudMaasModelInfo: convertModelInfoToProtoOpenRouter(config.actModeHuaweiCloudMaasModelInfo),
		actModeAihubmixModelId: config.actModeAihubmixModelId,
		actModeAihubmixModelInfo: convertOpenAiCompatibleModelInfoToProto(config.actModeAihubmixModelInfo),
		actModeNousResearchModelId: config.actModeNousResearchModelId,
		actModeVercelAiGatewayModelId: config.actModeVercelAiGatewayModelId,
		actModeVercelAiGatewayModelInfo: convertModelInfoToProtoOpenRouter(config.actModeVercelAiGatewayModelInfo),
		actModeOpenAiProfileName: config.actModeOpenAiProfileName,
	}
}

// Converts proto ApiConfiguration to application ApiConfiguration
export function convertProtoToApiConfiguration(protoConfig: ProtoApiConfiguration): ApiConfiguration {
	return {
		// Global configuration fields
		apiKey: protoConfig.apiKey,
		ulid: protoConfig.ulid,
		liteLlmBaseUrl: protoConfig.liteLlmBaseUrl,
		liteLlmApiKey: protoConfig.liteLlmApiKey,
		liteLlmUsePromptCache: protoConfig.liteLlmUsePromptCache,
		openAiHeaders: Object.keys(protoConfig.openAiHeaders || {}).length > 0 ? protoConfig.openAiHeaders : undefined,
		anthropicBaseUrl: protoConfig.anthropicBaseUrl,
		openRouterApiKey: protoConfig.openRouterApiKey,
		openRouterProviderSorting: protoConfig.openRouterProviderSorting,
		openRouterPinnedProviders: convertProtoToStringArrayMap(protoConfig.openRouterPinnedProviders),
		openRouterPreventFallbacks: protoConfig.openRouterPreventFallbacks,
		awsAccessKey: protoConfig.awsAccessKey,
		awsSecretKey: protoConfig.awsSecretKey,
		awsSessionToken: protoConfig.awsSessionToken,
		awsRegion: protoConfig.awsRegion,
		awsUseCrossRegionInference: protoConfig.awsUseCrossRegionInference,
		awsUseGlobalInference: protoConfig.awsUseGlobalInference,
		awsBedrockUsePromptCache: protoConfig.awsBedrockUsePromptCache,
		awsUseProfile: protoConfig.awsUseProfile,
		awsAuthentication: protoConfig.awsAuthentication,
		awsProfile: protoConfig.awsProfile,
		awsBedrockApiKey: protoConfig.awsBedrockApiKey,
		awsBedrockEndpoint: protoConfig.awsBedrockEndpoint,
		claudeCodePath: protoConfig.claudeCodePath,
		vertexProjectId: protoConfig.vertexProjectId,
		vertexRegion: protoConfig.vertexRegion,
		openAiBaseUrl: protoConfig.openAiBaseUrl,
		openAiApiKey: protoConfig.openAiApiKey,
		lmStudioBaseUrl: protoConfig.lmStudioBaseUrl,
		lmStudioMaxTokens: protoConfig.lmStudioMaxTokens,
		geminiApiKey: protoConfig.geminiApiKey,
		geminiBaseUrl: protoConfig.geminiBaseUrl,
		openAiNativeApiKey: protoConfig.openAiNativeApiKey,
		deepSeekApiKey: protoConfig.deepSeekApiKey,
		unbiasedApiKey: protoConfig.unbiasedApiKey,
		requestyApiKey: protoConfig.requestyApiKey,
		requestyBaseUrl: protoConfig.requestyBaseUrl,
		togetherApiKey: protoConfig.togetherApiKey,
		fireworksApiKey: protoConfig.fireworksApiKey,
		fireworksModelMaxCompletionTokens: protoConfig.fireworksModelMaxCompletionTokens,
		fireworksModelMaxTokens: protoConfig.fireworksModelMaxTokens,
		qwenApiKey: protoConfig.qwenApiKey,
		qwenCodeOauthPath: protoConfig.qwenCodeOauthPath,
		doubaoApiKey: protoConfig.doubaoApiKey,
		mistralApiKey: protoConfig.mistralApiKey,
		azureApiVersion: protoConfig.azureApiVersion,
		qwenApiLine: protoConfig.qwenApiLine,
		moonshotApiLine: protoConfig.moonshotApiLine,
		moonshotApiKey: protoConfig.moonshotApiKey,
		huggingFaceApiKey: protoConfig.huggingFaceApiKey,
		nebiusApiKey: protoConfig.nebiusApiKey,
		wandbApiKey: protoConfig.wandbApiKey,
		xaiApiKey: protoConfig.xaiApiKey,
		sambanovaApiKey: protoConfig.sambanovaApiKey,
		cerebrasApiKey: protoConfig.cerebrasApiKey,
		vercelAiGatewayApiKey: protoConfig.vercelAiGatewayApiKey,
		groqApiKey: protoConfig.groqApiKey,
		basetenApiKey: protoConfig.basetenApiKey,
		requestTimeoutMs: protoConfig.requestTimeoutMs,
		huaweiCloudMaasApiKey: protoConfig.huaweiCloudMaasApiKey,
		zaiApiLine: protoConfig.zaiApiLine,
		zaiApiKey: protoConfig.zaiApiKey,
		difyApiKey: protoConfig.difyApiKey,
		difyBaseUrl: protoConfig.difyBaseUrl,
		aihubmixApiKey: protoConfig.aihubmixApiKey,
		aihubmixBaseUrl: protoConfig.aihubmixBaseUrl,
		aihubmixAppCode: protoConfig.aihubmixAppCode,
		openAiCompatibleProfiles: (protoConfig.openAiCompatibleProfiles || []).map(convertProtoToOpenAiCompatibleProfile),
		minimaxApiKey: protoConfig.minimaxApiKey,
		minimaxApiLine: protoConfig.minimaxApiLine,
		nousResearchApiKey: protoConfig.nousResearchApiKey,

		// Plan mode configurations
		planModeApiProvider:
			protoConfig.planModeApiProvider !== undefined
				? convertProtoToApiProvider(protoConfig.planModeApiProvider)
				: undefined,
		planModeApiModelId: protoConfig.planModeApiModelId,
		planModeThinkingBudgetTokens: protoConfig.planModeThinkingBudgetTokens,
		geminiPlanModeThinkingLevel: protoConfig.geminiPlanModeThinkingLevel,
		planModeReasoningEffort: protoConfig.planModeReasoningEffort as OpenaiReasoningEffort | undefined,
		planModeInferenceSpeed: normalizeInferenceSpeed(protoConfig.planModeInferenceSpeed),
		planModeVsCodeLmModelSelector: protoConfig.planModeVsCodeLmModelSelector,
		planModeAwsBedrockCustomSelected: protoConfig.planModeAwsBedrockCustomSelected,
		planModeAwsBedrockCustomModelBaseId: protoConfig.planModeAwsBedrockCustomModelBaseId as BedrockModelId | undefined,
		planModeOpenRouterModelId: protoConfig.planModeOpenRouterModelId,
		planModeOpenRouterModelInfo: convertProtoToModelInfo(protoConfig.planModeOpenRouterModelInfo),
		planModeOpenAiModelId: protoConfig.planModeOpenAiModelId,
		planModeOpenAiModelInfo: convertProtoToOpenAiCompatibleModelInfo(protoConfig.planModeOpenAiModelInfo),
		planModeOpenAiProfileName: protoConfig.planModeOpenAiProfileName,
		planModeLmStudioModelId: protoConfig.planModeLmStudioModelId,
		planModeLiteLlmModelId: protoConfig.planModeLiteLlmModelId,
		planModeLiteLlmModelInfo: convertProtoToLiteLLMModelInfo(protoConfig.planModeLiteLlmModelInfo),
		planModeRequestyModelId: protoConfig.planModeRequestyModelId,
		planModeRequestyModelInfo: convertProtoToModelInfo(protoConfig.planModeRequestyModelInfo),
		planModeTogetherModelId: protoConfig.planModeTogetherModelId,
		planModeFireworksModelId: protoConfig.planModeFireworksModelId,
		planModeGroqModelId: protoConfig.planModeGroqModelId,
		planModeGroqModelInfo: convertProtoToModelInfo(protoConfig.planModeGroqModelInfo),
		planModeBasetenModelId: protoConfig.planModeBasetenModelId,
		planModeBasetenModelInfo: convertProtoToModelInfo(protoConfig.planModeBasetenModelInfo),
		planModeHuggingFaceModelId: protoConfig.planModeHuggingFaceModelId,
		planModeHuggingFaceModelInfo: convertProtoToModelInfo(protoConfig.planModeHuggingFaceModelInfo),
		planModeHuaweiCloudMaasModelId: protoConfig.planModeHuaweiCloudMaasModelId,
		planModeHuaweiCloudMaasModelInfo: convertProtoToModelInfo(protoConfig.planModeHuaweiCloudMaasModelInfo),
		planModeAihubmixModelId: protoConfig.planModeAihubmixModelId,
		planModeAihubmixModelInfo: convertProtoToOpenAiCompatibleModelInfo(protoConfig.planModeAihubmixModelInfo),
		planModeNousResearchModelId: protoConfig.planModeNousResearchModelId,
		planModeVercelAiGatewayModelId: protoConfig.planModeVercelAiGatewayModelId,
		planModeVercelAiGatewayModelInfo: convertProtoToModelInfo(protoConfig.planModeVercelAiGatewayModelInfo),

		// Act mode configurations
		actModeApiProvider:
			protoConfig.actModeApiProvider !== undefined ? convertProtoToApiProvider(protoConfig.actModeApiProvider) : undefined,
		actModeApiModelId: protoConfig.actModeApiModelId,
		actModeThinkingBudgetTokens: protoConfig.actModeThinkingBudgetTokens,
		geminiActModeThinkingLevel: protoConfig.geminiActModeThinkingLevel,
		actModeReasoningEffort: protoConfig.actModeReasoningEffort as OpenaiReasoningEffort | undefined,
		actModeInferenceSpeed: normalizeInferenceSpeed(protoConfig.actModeInferenceSpeed),
		actModeVsCodeLmModelSelector: protoConfig.actModeVsCodeLmModelSelector,
		actModeAwsBedrockCustomSelected: protoConfig.actModeAwsBedrockCustomSelected,
		actModeAwsBedrockCustomModelBaseId: protoConfig.actModeAwsBedrockCustomModelBaseId as BedrockModelId | undefined,
		actModeOpenRouterModelId: protoConfig.actModeOpenRouterModelId,
		actModeOpenRouterModelInfo: convertProtoToModelInfo(protoConfig.actModeOpenRouterModelInfo),
		actModeOpenAiModelId: protoConfig.actModeOpenAiModelId,
		actModeOpenAiModelInfo: convertProtoToOpenAiCompatibleModelInfo(protoConfig.actModeOpenAiModelInfo),
		actModeOpenAiProfileName: protoConfig.actModeOpenAiProfileName,
		actModeLmStudioModelId: protoConfig.actModeLmStudioModelId,
		actModeLiteLlmModelId: protoConfig.actModeLiteLlmModelId,
		actModeLiteLlmModelInfo: convertProtoToLiteLLMModelInfo(protoConfig.actModeLiteLlmModelInfo),
		actModeRequestyModelId: protoConfig.actModeRequestyModelId,
		actModeRequestyModelInfo: convertProtoToModelInfo(protoConfig.actModeRequestyModelInfo),
		actModeTogetherModelId: protoConfig.actModeTogetherModelId,
		actModeFireworksModelId: protoConfig.actModeFireworksModelId,
		actModeGroqModelId: protoConfig.actModeGroqModelId,
		actModeGroqModelInfo: convertProtoToModelInfo(protoConfig.actModeGroqModelInfo),
		actModeBasetenModelId: protoConfig.actModeBasetenModelId,
		actModeBasetenModelInfo: convertProtoToModelInfo(protoConfig.actModeBasetenModelInfo),
		actModeHuggingFaceModelId: protoConfig.actModeHuggingFaceModelId,
		actModeHuggingFaceModelInfo: convertProtoToModelInfo(protoConfig.actModeHuggingFaceModelInfo),
		actModeHuaweiCloudMaasModelId: protoConfig.actModeHuaweiCloudMaasModelId,
		actModeHuaweiCloudMaasModelInfo: convertProtoToModelInfo(protoConfig.actModeHuaweiCloudMaasModelInfo),
		actModeAihubmixModelId: protoConfig.actModeAihubmixModelId,
		actModeAihubmixModelInfo: convertProtoToOpenAiCompatibleModelInfo(protoConfig.actModeAihubmixModelInfo),
		actModeNousResearchModelId: protoConfig.actModeNousResearchModelId,
		actModeVercelAiGatewayModelId: protoConfig.actModeVercelAiGatewayModelId,
		actModeVercelAiGatewayModelInfo: convertProtoToModelInfo(protoConfig.actModeVercelAiGatewayModelInfo),
	}
}
