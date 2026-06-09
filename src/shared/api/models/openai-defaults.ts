import type { OpenAiCompatibleModelInfo } from "./types"

export const openAiModelInfoSaneDefaults: OpenAiCompatibleModelInfo = {
	maxTokens: -1,
	contextWindow: 256_000,
	supportsImages: true,
	supportsPromptCache: false,
	supportsTools: true,
	supportsReasoning: true,
	supportsStrictTools: false,
	isR1FormatRequired: false,
	inputPrice: 0,
	outputPrice: 0,
	temperature: 0,
}

// Azure OpenAI
// https://learn.microsoft.com/en-us/azure/ai-services/openai/api-version-deprecation
// https://learn.microsoft.com/en-us/azure/ai-services/openai/reference#api-specs
export const azureOpenAiDefaultApiVersion = "2024-08-01-preview"
