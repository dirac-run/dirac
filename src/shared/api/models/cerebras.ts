import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type CerebrasModelId = keyof typeof cerebrasModels

export const cerebrasDefaultModelId: CerebrasModelId = "zai-glm-4.7"

export const cerebrasModels = {
	"zai-glm-4.7": {
		...MODEL_CAPABILITIES["zai-glm-4.7"],
		supportsPromptCache: false,
		temperature: 0.9,
		inputPrice: 0,
		outputPrice: 0,
		description:
			"Highly capable general-purpose model on Cerebras (up to 1,000 tokens/s), competitive with leading proprietary models on coding tasks.",
	},
	"gpt-oss-120b": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		maxTokens: 65536,
		contextWindow: 128000,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Intelligent general purpose model with 3,000 tokens/s",
	},
	"qwen-3-235b-a22b-instruct-2507": {
		maxTokens: 64000,
		contextWindow: 64000,
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Intelligent model with ~1400 tokens/s",
	},
} as const satisfies Record<string, ModelInfo>
