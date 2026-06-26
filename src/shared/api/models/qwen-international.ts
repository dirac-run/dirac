import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type InternationalQwenModelId = keyof typeof internationalQwenModels

export const internationalQwenModels = {
	"qwen-turbo-latest": {
		...MODEL_CAPABILITIES["qwen-turbo-latest"],
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.6,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.6,
		thinkingConfig: {
			maxBudget: 38_912,
			outputPrice: 6,
		},
	},
	"qwen-max-latest": {
		...MODEL_CAPABILITIES["qwen-max-latest"],
		supportsPromptCache: false,
		inputPrice: 2.4,
		outputPrice: 9.6,
		cacheWritesPrice: 2.4,
		cacheReadsPrice: 9.6,
	},
} as const satisfies Record<string, ModelInfo>

export const internationalQwenDefaultModelId: InternationalQwenModelId = Object.keys(
	internationalQwenModels,
)[0] as InternationalQwenModelId
