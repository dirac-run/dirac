import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"
import { CLAUDE_SONNET_1M_TIERS, CLAUDE_OPUS_1M_TIERS } from "./shared-tiers"

export type BedrockModelId = keyof typeof bedrockModels

export const bedrockDefaultModelId: BedrockModelId = "anthropic.claude-sonnet-4-6"

export const bedrockModels = {
	"anthropic.claude-sonnet-4-6": {
		...MODEL_CAPABILITIES["claude-sonnet-4-6"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	"anthropic.claude-sonnet-4-6:1m": {
		...MODEL_CAPABILITIES["claude-sonnet-4-6:1m"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"anthropic.claude-sonnet-4-5-20250929-v1:0:1m": {
		...MODEL_CAPABILITIES["claude-sonnet-4-5-20250929:1m"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"anthropic.claude-haiku-4-5-20251001-v1:0": {
		...MODEL_CAPABILITIES["claude-haiku-4-5-20251001"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 1,
		outputPrice: 5.0,
		cacheWritesPrice: 1.25,
		cacheReadsPrice: 0.1,
	},
	"anthropic.claude-sonnet-4-20250514-v1:0:1m": {
		...MODEL_CAPABILITIES["claude-sonnet-4-20250514:1m"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		tiers: CLAUDE_SONNET_1M_TIERS,
	},
	"anthropic.claude-opus-4-6-v1": {
		...MODEL_CAPABILITIES["claude-opus-4-6"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	"anthropic.claude-opus-4-6-v1:1m": {
		...MODEL_CAPABILITIES["claude-opus-4-6:1m"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		tiers: CLAUDE_OPUS_1M_TIERS,
	},
	"openai.gpt-oss-120b-1:0": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.6,
		description:
			"A state-of-the-art 120B open-weight Mixture-of-Experts language model optimized for strong reasoning, tool use, and efficient deployment on large GPUs",
	},
	"openai.gpt-oss-20b-1:0": {
		...MODEL_CAPABILITIES["gpt-oss-20b"],
		supportsPromptCache: false,
		inputPrice: 0.07,
		outputPrice: 0.3,
		description:
			"A compact 20B open-weight Mixture-of-Experts language model designed for strong reasoning and tool use, ideal for edge devices and local inference.",
	},
	"anthropic.claude-opus-4-8-v1": {
		...MODEL_CAPABILITIES["claude-opus-4-8"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	"anthropic.claude-opus-4-8-v1:1m": {
		...MODEL_CAPABILITIES["claude-opus-4-8:1m"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
		tiers: CLAUDE_OPUS_1M_TIERS,
	},
	"anthropic.claude-fable-5-v1": {
		...MODEL_CAPABILITIES["claude-fable-5"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 10.0,
		outputPrice: 50.0,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1.0,
	},
} as const satisfies Record<string, ModelInfo>
