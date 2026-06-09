import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type DoubaoModelId = keyof typeof doubaoModels

export const doubaoDefaultModelId: DoubaoModelId = "doubao-1-5-pro-256k-250115"

export const doubaoModels = {
	"doubao-1-5-pro-256k-250115": {
		...MODEL_CAPABILITIES["doubao-1-5-pro-256k-250115"],
		supportsPromptCache: false,
		inputPrice: 0.7,
		outputPrice: 1.3,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"doubao-1-5-pro-32k-250115": {
		...MODEL_CAPABILITIES["doubao-1-5-pro-32k-250115"],
		supportsPromptCache: false,
		inputPrice: 0.11,
		outputPrice: 0.3,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"deepseek-v3-250324": {
		...MODEL_CAPABILITIES["deepseek-v3-250324"],
		supportsPromptCache: false,
		inputPrice: 0.55,
		outputPrice: 2.19,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"deepseek-r1-250120": {
		...MODEL_CAPABILITIES["deepseek-r1-250120"],
		supportsPromptCache: false,
		inputPrice: 0.27,
		outputPrice: 1.09,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
} as const satisfies Record<string, ModelInfo>
