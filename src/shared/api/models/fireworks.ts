import type { OpenAiCompatibleModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type FireworksModelId = keyof typeof fireworksModels

export const fireworksDefaultModelId: FireworksModelId = "accounts/fireworks/models/kimi-k2p6"

export const fireworksModels = {
	"accounts/fireworks/models/kimi-k2p6": {
		...MODEL_CAPABILITIES["kimi-k2.6"],
		isR1FormatRequired: true,
		maxTokens: 16384,
		contextWindow: 262144,
		supportsPromptCache: true,
		inputPrice: 0.95,
		outputPrice: 4,
		cacheReadsPrice: 0.16,
		description:
			"Moonshot's flagship open agentic model. Kimi K2.5 unifies vision and text, thinking and non-thinking modes, and single-agent and multi-agent execution.",
	},
	"accounts/fireworks/models/kimi-k2p5": {
		...MODEL_CAPABILITIES["kimi-k2.5"],
		isR1FormatRequired: true,
		maxTokens: 16384,
		contextWindow: 262144,
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 3,
		cacheWritesPrice: 0.6,
		cacheReadsPrice: 0.1,
		description:
			"Moonshot's flagship open agentic model. Kimi K2.5 unifies vision and text, thinking and non-thinking modes, and single-agent and multi-agent execution.",
	},
	"accounts/fireworks/models/deepseek-v3p2": {
		...MODEL_CAPABILITIES["DeepSeek-V3.2"],
		maxTokens: 16384,
		contextWindow: 163840,
		supportsPromptCache: true,
		inputPrice: 0.56,
		outputPrice: 1.68,
		cacheWritesPrice: 0.56,
		cacheReadsPrice: 0.28,
		description: "DeepSeek V3.2 model tuned for high computational efficiency and strong reasoning and agent performance.",
	},
	"accounts/fireworks/models/glm-5": {
		...MODEL_CAPABILITIES["glm-5"],
		maxTokens: 16384,
		contextWindow: 202752,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 1.0,
		outputPrice: 3.2,
		cacheWritesPrice: 1.0,
		cacheReadsPrice: 0.2,
		description: "GLM-5 is Z.ai's flagship reasoning model for complex systems engineering and long-horizon agentic tasks.",
	},
	"accounts/fireworks/models/minimax-m2p5": {
		...MODEL_CAPABILITIES["MiniMax-M2.5"],
		contextWindow: 196608,
		supportsReasoning: true,
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.03,
		description: "MiniMax M2.5 is built for state-of-the-art coding, agentic tool use.",
	},
	"accounts/fireworks/models/minimax-m2p1": {
		...MODEL_CAPABILITIES["MiniMax-M2.1"],
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.03,
		description:
			"MiniMax M2.1 is tuned for strong real-world performance across coding, agent-driven, and workflow-heavy tasks.",
	},
	"accounts/fireworks/models/gpt-oss-120b": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		maxTokens: 16384,
		contextWindow: 131072,
		supportsPromptCache: true,
		inputPrice: 0.15,
		outputPrice: 0.6,
		cacheWritesPrice: 0.15,
		cacheReadsPrice: 0.01,
		description: "OpenAI gpt-oss-120b open-weight model for production and high-reasoning use cases.",
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
