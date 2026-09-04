import { MODEL_CAPABILITIES } from "./capabilities"
import type { OpenAiCompatibleModelInfo } from "./types"

export type NebiusModelId = keyof typeof nebiusModels
export const nebiusDefaultModelId = "openai/gpt-oss-120b" satisfies NebiusModelId

export const nebiusModels = {
	// Pricing and context per Nebius Token Factory model catalog
	// (https://tokenfactory.nebius.com/model-catalog.md)
	"openai/gpt-oss-120b": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		maxTokens: 32766, // Quantization: fp4
		contextWindow: 131_000,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
	},
	"openai/gpt-oss-20b": {
		...MODEL_CAPABILITIES["gpt-oss-20b"],
		maxTokens: 32766, // Quantization: fp4
		contextWindow: 131_000,
		supportsPromptCache: false,
		inputPrice: 0.05,
		outputPrice: 0.2,
	},
	"zai-org/GLM-5.1": {
		...MODEL_CAPABILITIES["glm-5.1"],
		supportsPromptCache: false,
		inputPrice: 1.4,
		outputPrice: 4.4,
	},
	"zai-org/GLM-5.2": {
		...MODEL_CAPABILITIES["glm-5.2"],
		supportsPromptCache: false,
		inputPrice: 1.4,
		outputPrice: 4.4,
	},
	"zai-org/GLM-5.3-Flash": {
		...MODEL_CAPABILITIES["glm-5.3-flash"],
		// Nebius currently serves this model text-only.
		supportsImages: false,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.5,
	},
	"moonshotai/Kimi-K2.6": {
		...MODEL_CAPABILITIES["kimi-k2.6"],
		supportsPromptCache: false,
		inputPrice: 0.95,
		outputPrice: 4,
		isR1FormatRequired: true,
	},
	"moonshotai/Kimi-K3": {
		...MODEL_CAPABILITIES["kimi-k3"],
		supportsPromptCache: false,
		inputPrice: 3,
		outputPrice: 15,
		isR1FormatRequired: true,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
