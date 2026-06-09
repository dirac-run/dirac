import type { OpenAiCompatibleModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type mainlandZAiModelId = keyof typeof mainlandZAiModels

export const mainlandZAiDefaultModelId: mainlandZAiModelId = "glm-5"

export const mainlandZAiModels = {
	"glm-5.1": {
		...MODEL_CAPABILITIES["glm-5.1"],
		supportsPromptCache: true,
		thinkingConfig: {
			maxBudget: 128_000,
		},
		cacheReadsPrice: 0.26,
		inputPrice: 1.4,
		outputPrice: 4.4,
	},
	"glm-5": {
		...MODEL_CAPABILITIES["glm-5"],
		maxTokens: 128_000,
		supportsPromptCache: true,
		supportsReasoning: true,
		thinkingConfig: {
			maxBudget: 128_000,
		},
		cacheReadsPrice: 0.2,
		inputPrice: 1.0,
		outputPrice: 3.2,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
