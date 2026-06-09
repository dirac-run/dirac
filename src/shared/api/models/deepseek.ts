import type { OpenAiCompatibleModelInfo } from "./types"

export type DeepSeekModelId = keyof typeof deepSeekModels

export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-v4-flash"

export const deepSeekModels = {
    "deepseek-v4-flash": {
        maxTokens: 384_000,
        contextWindow: 1_048_576,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoning: true,
        supportsReasoningEffort: true,
        supportsTools: true,
        inputPrice: 0,
        outputPrice: 0.28,
        cacheWritesPrice: 0.14,
        cacheReadsPrice: 0.0028,
    },
    "deepseek-v4-pro": {
        maxTokens: 384_000,
        contextWindow: 1_048_576,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoning: true,
        supportsReasoningEffort: true,
        supportsTools: true,
        inputPrice: 0,
        outputPrice: 3.48,
        cacheWritesPrice: 1.74,
        cacheReadsPrice: 0.0145,
    },
    "deepseek-chat": {
        maxTokens: 8_000,
        contextWindow: 128_000,
        supportsImages: false,
        supportsPromptCache: true, // supports context caching, but not in the way anthropic does it (deepseek reports input tokens and reads/writes in the same usage report) FIXME: we need to show users cache stats how deepseek does it
        inputPrice: 0, // technically there is no input price, it's all either a cache hit or miss (ApiOptions will not show this). Input is the sum of cache reads and writes
        outputPrice: 1.1,
        cacheWritesPrice: 0.27,
        cacheReadsPrice: 0.07,
    },
    "deepseek-reasoner": {
        maxTokens: 8_000,
        contextWindow: 128_000,
        supportsImages: false,
        supportsPromptCache: true,
        supportsReasoning: true,
        supportsTools: true,
        inputPrice: 0,
        outputPrice: 2.19,
        cacheWritesPrice: 0.55,
        cacheReadsPrice: 0.14,
    },
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
