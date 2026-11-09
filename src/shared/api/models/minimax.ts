import { MODEL_CAPABILITIES } from "./capabilities"
import type { ModelInfo } from "./types"

export type MinimaxModelId = keyof typeof minimaxModels

export const minimaxDefaultModelId: MinimaxModelId = "MiniMax-M3"

export const minimaxModels = {
	"MiniMax-M2.7": {
		...MODEL_CAPABILITIES["MiniMax-M2.7"],
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.06,
		description: "Latest flagship model with enhanced reasoning and coding",
	},
	"MiniMax-M2.7-highspeed": {
		...MODEL_CAPABILITIES["MiniMax-M2.7-highspeed"],
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 2.4,
		cacheWritesPrice: 0.375,
		cacheReadsPrice: 0.06,
		description: "High-speed version of M2.7 for low-latency scenarios",
	},
	"MiniMax-M3": {
		...MODEL_CAPABILITIES["MiniMax-M3"],
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 1.2,
		cacheWritesPrice: 0.3,
		cacheReadsPrice: 0.06,
		description: "Latest M-series language model for agentic reasoning, tool use, coding, and long-context tasks",
	},
	"MiniMax-M3.1-Flash": {
		...MODEL_CAPABILITIES["MiniMax-M3.1-Flash"],
		supportsPromptCache: true,
		inputPrice: 0.15,
		outputPrice: 0.6,
		cacheWritesPrice: 0.15,
		cacheReadsPrice: 0.015,
		description: "Multimodal coding model with 1M context, always-on thinking, and tunable reasoning effort",
	},
} as const satisfies Record<string, ModelInfo>
