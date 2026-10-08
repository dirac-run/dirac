import type { OpenAiCompatibleModelInfo } from "./types"

export type AtlasCloudModelId = keyof typeof atlascloudModels
export const atlascloudDefaultModelId = "deepseek-ai/deepseek-v4-flash" satisfies AtlasCloudModelId

// Context windows, output limits and prices are copied from the gateway's own
// catalog (GET https://api.atlascloud.ai/v1/models, read 2026-10-08); prices are
// per million tokens. `supportsTools` and `supportsReasoning` were confirmed by
// calling every id below with a tool definition and checking for `tool_calls`
// and `reasoning_content` in the response, rather than trusting the catalog's
// `supported_features` field (which is empty for qwen3.5-flash even though the
// model does return both).
export const atlascloudModels = {
	"deepseek-ai/deepseek-v4-flash": {
		maxTokens: 393216,
		contextWindow: 1048576,
		supportsImages: false,
		supportsPromptCache: true,
		supportsTools: true,
		supportsReasoning: true,
		inputPrice: 0.14,
		outputPrice: 0.28,
		cacheReadsPrice: 0.028,
	},
	"deepseek-ai/deepseek-v4-pro": {
		maxTokens: 393216,
		contextWindow: 1048576,
		supportsImages: false,
		supportsPromptCache: true,
		supportsTools: true,
		supportsReasoning: true,
		inputPrice: 1.68,
		outputPrice: 3.38,
		cacheReadsPrice: 0.13,
	},
	"zai-org/glm-5.3": {
		maxTokens: 131072,
		contextWindow: 1048576,
		supportsImages: false,
		supportsPromptCache: true,
		supportsTools: true,
		supportsReasoning: true,
		inputPrice: 1.4,
		outputPrice: 4.4,
		cacheReadsPrice: 0.26,
	},
	"moonshotai/kimi-k2.6": {
		maxTokens: 262144,
		contextWindow: 262144,
		supportsImages: true,
		supportsPromptCache: true,
		supportsTools: true,
		supportsReasoning: true,
		inputPrice: 0.95,
		outputPrice: 4,
		cacheReadsPrice: 0.16,
	},
	"qwen/qwen3.5-flash": {
		maxTokens: 67072,
		contextWindow: 1000000,
		supportsImages: true,
		// The catalog quotes the same price for cached and uncached input, so
		// there is nothing to gain from advertising prompt caching here.
		supportsPromptCache: false,
		supportsTools: true,
		supportsReasoning: true,
		inputPrice: 0.1,
		outputPrice: 0.4,
	},
	"minimaxai/minimax-m2.5": {
		maxTokens: 196608,
		contextWindow: 196608,
		supportsImages: false,
		supportsPromptCache: true,
		supportsTools: true,
		supportsReasoning: true,
		inputPrice: 0.295,
		outputPrice: 1.2,
		cacheReadsPrice: 0.06,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
