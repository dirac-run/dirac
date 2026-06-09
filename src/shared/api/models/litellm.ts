import type { ModelInfo } from "./types"

// LiteLLM
// https://docs.litellm.ai/docs/
export type LiteLLMModelId = string
export const liteLlmDefaultModelId = "anthropic/claude-4-6-sonnet"
export interface LiteLLMModelInfo extends ModelInfo {
	temperature?: number
}

export const liteLlmModelInfoSaneDefaults: LiteLLMModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 0,
	supportsTools: true,
	outputPrice: 0,
	cacheWritesPrice: 0,
	cacheReadsPrice: 0,
	temperature: 0,
}
