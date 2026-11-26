import { ApiConfiguration, ModelInfo } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { getModeSpecificFields } from "@/features/settings/components/utils/providerUtils"

export function validateApiConfiguration(currentMode: Mode, apiConfiguration?: ApiConfiguration): string | undefined {
	if (apiConfiguration) {
		const { apiProvider, openAiModelId, requestyModelId, togetherModelId, lmStudioModelId, vsCodeLmModelSelector } =
			getModeSpecificFields(apiConfiguration, currentMode)

		switch (apiProvider) {
			case "anthropic":
				if (!apiConfiguration.apiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "bedrock":
				if (!apiConfiguration.awsRegion) {
					return "You must choose a region to use with AWS Bedrock."
				}
				break
			case "openrouter":
				if (!apiConfiguration.openRouterApiKey || !getModeSpecificFields(apiConfiguration, currentMode).openRouterModelId) {
					return "You must provide a valid API key and model ID or choose a different provider."
				}
				break
			case "vertex":
				if (!apiConfiguration.vertexProjectId || !apiConfiguration.vertexRegion) {
					return "You must provide a valid Google Cloud Project ID and Region. You can also set these via GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables."
				}
				break
			case "gemini":
				if (!apiConfiguration.geminiApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "openai-native":
				if (!apiConfiguration.openAiNativeApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "deepseek":
				if (!apiConfiguration.deepSeekApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "xai":
				if (!apiConfiguration.xaiApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "qwen":
				if (!apiConfiguration.qwenApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "doubao":
				if (!apiConfiguration.doubaoApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "mistral":
				if (!apiConfiguration.mistralApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "openai-codex":
				// Authentication is handled via OAuth, not API key
				// Validation happens at runtime in the handler
				break
			case "openai":
				if (
					!apiConfiguration.openAiBaseUrl ||
					!apiConfiguration.openAiApiKey /* && !apiConfiguration.azureIdentity */ ||
					!openAiModelId
				) {
					return "You must provide a valid base URL, API key, and model ID."
				}
				break
			case "requesty":
				if (!apiConfiguration.requestyApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "fireworks":
				if (!apiConfiguration.fireworksApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "together":
				if (!apiConfiguration.togetherApiKey || !togetherModelId) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "lmstudio":
				if (!lmStudioModelId) {
					return "You must provide a valid model ID."
				}
				break
			case "vscode-lm":
				if (!vsCodeLmModelSelector) {
					return "You must provide a valid model selector."
				}
				break
			case "moonshot":
				if (!apiConfiguration.moonshotApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "nebius":
				if (!apiConfiguration.nebiusApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "sambanova":
				if (!apiConfiguration.sambanovaApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "zai":
				if (!apiConfiguration.zaiApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "dify":
				if (!apiConfiguration.difyBaseUrl) {
					return "You must provide a valid Base URL or choose a different provider."
				}
				if (!apiConfiguration.difyApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "minimax":
				if (!apiConfiguration.minimaxApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "wandb":
				if (!apiConfiguration.wandbApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
		}
	}
	return undefined
}

export function validateModelId(
	currentMode: Mode,
	apiConfiguration?: ApiConfiguration,
	openRouterModels?: Record<string, ModelInfo>,
): string | undefined {
	if (apiConfiguration) {
		const { apiProvider, openRouterModelId } = getModeSpecificFields(apiConfiguration, currentMode)
		if (apiProvider === "openrouter") {
			if (!openRouterModelId) {
				return "You must provide a model ID."
			}
			if (openRouterModels && !Object.keys(openRouterModels).includes(openRouterModelId)) {
				return "The model ID you provided is not available. Please choose a different model."
			}
		}
	}
	return undefined
}
