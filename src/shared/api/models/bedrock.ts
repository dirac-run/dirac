import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type BedrockModelId = keyof typeof bedrockModels

export const bedrockDefaultModelId: BedrockModelId = "anthropic.claude-sonnet-5"

export const bedrockModels = {
	"anthropic.claude-sonnet-5-5": {
		...MODEL_CAPABILITIES["claude-sonnet-5-5"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		description: "Requires a supported geographic or global inference profile. Bedrock pricing is not yet verified; cost estimates are unavailable.",
	},
	"anthropic.claude-haiku-5-5": {
		...MODEL_CAPABILITIES["claude-haiku-5-5"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		description: "Requires a supported geographic or global inference profile. Bedrock pricing is not yet verified; cost estimates are unavailable.",
	},
	"anthropic.claude-sonnet-4-6": {
		...MODEL_CAPABILITIES["claude-sonnet-4-6"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	"anthropic.claude-sonnet-5": {
		...MODEL_CAPABILITIES["claude-sonnet-5"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
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
	"anthropic.claude-opus-4-6-v1": {
		...MODEL_CAPABILITIES["claude-opus-4-6"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
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
	"anthropic.claude-opus-5-v1": {
		...MODEL_CAPABILITIES["claude-opus-5"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 5.0,
		outputPrice: 25.0,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	"anthropic.claude-opus-5-5": {
		...MODEL_CAPABILITIES["claude-opus-5-5"],
		supportsPromptCache: true,
		supportsGlobalEndpoint: true,
		inputPrice: 4.0,
		outputPrice: 20.0,
		cacheWritesPrice: 5.0,
		cacheReadsPrice: 0.2,
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
