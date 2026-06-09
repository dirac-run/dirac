import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type MistralModelId = keyof typeof mistralModels

export const mistralDefaultModelId: MistralModelId = "devstral-2512"

export const mistralModels = {
	"devstral-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
	},
	"labs-devstral-small-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
	},
	"mistral-large-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.5,
		outputPrice: 1.5,
	},
	"ministral-14b-2512": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 0.2,
	},
	"mistral-small-latest": {
		maxTokens: 128_000,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.3,
	},
	"mistral-medium-latest": {
		maxTokens: 128_000,
		contextWindow: 128_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0.4,
		outputPrice: 2.0,
	},
	"mistral-medium-3-5": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 1.5,
		outputPrice: 7.5,
	},
	"mistral-small-2501": {
		maxTokens: 32_000,
		contextWindow: 32_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.3,
	},
	"open-codestral-mamba": {
		maxTokens: 256_000,
		contextWindow: 256_000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.15,
	},
	"codestral-2501": {
		...MODEL_CAPABILITIES["codestral-2501"],
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.9,
	},
	"devstral-small-2505": {
		maxTokens: 128_000,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.3,
	},
	"devstral-medium-latest": {
		maxTokens: 128_000,
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.4,
		outputPrice: 2.0,
	},
} as const satisfies Record<string, ModelInfo>
