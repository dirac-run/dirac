import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type NebiusModelId = keyof typeof nebiusModels
export const nebiusDefaultModelId = "openai/gpt-oss-120b" satisfies NebiusModelId

export const nebiusModels = {
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
} as const satisfies Record<string, ModelInfo>
