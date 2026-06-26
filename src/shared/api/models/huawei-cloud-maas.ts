import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type HuaweiCloudMaasModelId = keyof typeof huaweiCloudMaasModels

export const huaweiCloudMaasDefaultModelId: HuaweiCloudMaasModelId = "DeepSeek-V3"

export const huaweiCloudMaasModels = {
	"DeepSeek-V3": {
		...MODEL_CAPABILITIES["DeepSeek-V3"],
		supportsPromptCache: false,
		inputPrice: 0.27,
		outputPrice: 1.1,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
	},
	"DeepSeek-R1": {
		...MODEL_CAPABILITIES["DeepSeek-R1"],
		maxTokens: 16_384,
		supportsPromptCache: false,
		inputPrice: 0.55,
		outputPrice: 2.2,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		thinkingConfig: {
			maxBudget: 8192,
			outputPrice: 2.2,
		},
	},
} as const satisfies Record<string, ModelInfo>
