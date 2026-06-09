import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"




export type WandbModelId = keyof typeof wandbModels
export const wandbDefaultModelId = "openai/gpt-oss-120b" satisfies WandbModelId

export const wandbModels = {
	"MiniMaxAI/MiniMax-M2.5": {
		...MODEL_CAPABILITIES["MiniMaxAI/MiniMax-M2.5"],
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 1.2,
		description:
			"MoE model with a highly sparse architecture designed for high-throughput and low latency with strong coding capabilities",
	},
	"nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8": {
		...MODEL_CAPABILITIES["nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8"],
		supportsPromptCache: false,
		inputPrice: 0.2,
		outputPrice: 0.8,
		description: "A LatentMoE model designed to deliver strong agentic, reasoning, and conversational capabilities",
	},
	"openai/gpt-oss-120b": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		maxTokens: 32_768,
		contextWindow: 131_000,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
		description: "Efficient Mixture-of-Experts model designed for high-reasoning, agentic and general-purpose use cases",
	},
	"openai/gpt-oss-20b": {
		...MODEL_CAPABILITIES["gpt-oss-20b"],
		maxTokens: 32_768,
		contextWindow: 131_000,
		supportsPromptCache: false,
		inputPrice: 0.05,
		outputPrice: 0.2,
		description:
			"Lower latency Mixture-of-Experts model trained on OpenAI’s Harmony response format with reasoning capabilities",
	},
	"zai-org/GLM-5-FP8": {
		...MODEL_CAPABILITIES["glm-5"],
		supportsPromptCache: false,
		inputPrice: 1.0,
		outputPrice: 3.2,
		description: "Mixture-of-Experts model for long-horizon agentic tasks with strong performance on reasoning and coding",
	},
} as const satisfies Record<string, ModelInfo>
