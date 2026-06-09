import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type HuggingFaceModelId = keyof typeof huggingFaceModels

export const huggingFaceDefaultModelId: HuggingFaceModelId = "moonshotai/Kimi-K2-Instruct"

export const huggingFaceModels = {
	"openai/gpt-oss-120b": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		maxTokens: 32766,
		contextWindow: 131_072,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description:
			"Large open-weight reasoning model for high-end desktops and data centers, built for complex coding, math, and general AI tasks.",
	},
	"openai/gpt-oss-20b": {
		...MODEL_CAPABILITIES["gpt-oss-20b"],
		maxTokens: 32766,
		contextWindow: 131_072,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description:
			"Medium open-weight reasoning model that runs on most desktops, balancing strong reasoning with broad accessibility.",
	},
	"moonshotai/Kimi-K2-Instruct": {
		...MODEL_CAPABILITIES["moonshotai/Kimi-K2-Instruct"],
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Advanced reasoning model with superior performance across coding, math, and general capabilities.",
	},
	"deepseek-ai/DeepSeek-R1": {
		...MODEL_CAPABILITIES["DeepSeek-R1"],
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "DeepSeek's reasoning model with step-by-step thinking capabilities.",
	},
} as const satisfies Record<string, ModelInfo>
