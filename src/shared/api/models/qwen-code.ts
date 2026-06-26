import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type QwenCodeModelId = keyof typeof qwenCodeModels
export const qwenCodeDefaultModelId: QwenCodeModelId = "qwen3-coder-plus"

export const qwenCodeModels = {
	"qwen3-coder-plus": {
		...MODEL_CAPABILITIES["qwen3-coder-plus"],
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Qwen3 Coder Plus - High-performance coding model with 1M context window for large codebases",
	},
	"qwen3-coder-flash": {
		...MODEL_CAPABILITIES["qwen3-coder-flash"],
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		cacheWritesPrice: 0,
		cacheReadsPrice: 0,
		description: "Qwen3 Coder Flash - Fast coding model with 1M context window optimized for speed",
	},
} as const satisfies Record<string, ModelInfo>
