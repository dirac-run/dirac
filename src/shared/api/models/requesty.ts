import type { ModelInfo } from "./types"

// Requesty
// https://requesty.ai/models
export const requestyDefaultModelId = "anthropic/claude-4-6-sonnet-latest"
export const requestyDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
	description: "Anthropic's most intelligent model. Highest level of intelligence and capability.",
}
