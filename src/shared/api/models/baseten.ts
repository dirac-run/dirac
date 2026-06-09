import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"


export type BasetenModelId = keyof typeof basetenModels
export const basetenDefaultModelId = "zai-org/GLM-4.6" satisfies BasetenModelId

export const basetenModels = {
	"moonshotai/Kimi-K2-Thinking": {
		...MODEL_CAPABILITIES["kimi-k2-thinking"],
		supportsPromptCache: false,
		inputPrice: 0.6,
		outputPrice: 2.5,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Kimi K2 Thinking - A model with enhanced reasoning capabilities from Kimi K2",
	},
	"zai-org/GLM-4.6": {
		...MODEL_CAPABILITIES["glm-4.6"],
		supportsPromptCache: false,
		inputPrice: 0.6,
		outputPrice: 2.2,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Frontier open model with advanced agentic, reasoning and coding capabilities",
	},
	"deepseek-ai/DeepSeek-R1": {
		...MODEL_CAPABILITIES["DeepSeek-R1"],
		maxTokens: 131_072,
		contextWindow: 163_840,
		supportsPromptCache: false,
		inputPrice: 2.55,
		outputPrice: 5.95,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "DeepSeek's first-generation reasoning model",
		supportsReasoning: true,
	},
	"deepseek-ai/DeepSeek-V3.2": {
		...MODEL_CAPABILITIES["DeepSeek-V3.2"],
		supportsPromptCache: false,
		inputPrice: 0.3,
		outputPrice: 0.45,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "DeepSeek's hybrid reasoning model with efficient long context scaling with GPT-5 level performance",
	},
	"openai/gpt-oss-120b": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		maxTokens: 128_072,
		contextWindow: 128_072,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.5,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Extremely capable general-purpose LLM with strong, controllable reasoning capabilities",
		supportsReasoning: true,
	},
} as const satisfies Record<string, ModelInfo>
