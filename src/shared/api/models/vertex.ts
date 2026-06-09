import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"
import { CLAUDE_SONNET_1M_TIERS, CLAUDE_OPUS_1M_TIERS } from "./shared-tiers"

export type VertexModelId = keyof typeof vertexModels

export const vertexDefaultModelId: VertexModelId = "gemini-3-pro-preview"

export const vertexModels = {
    "gemini-3.1-pro-preview": {
        ...MODEL_CAPABILITIES["gemini-3.1-pro-preview"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 2.0,
        outputPrice: 12.0,
        temperature: 1.0,
        thinkingConfig: {
            geminiThinkingLevel: "high" as const,
            supportsThinkingLevel: true,
        },
    },
    "gemini-3-pro-preview": {
        ...MODEL_CAPABILITIES["gemini-3-pro-preview"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 2.0,
        outputPrice: 12.0,
        temperature: 1.0,
        thinkingConfig: {
            geminiThinkingLevel: "high" as const,
            supportsThinkingLevel: true,
        },
    },
    "gemini-3-flash-preview": {
        ...MODEL_CAPABILITIES["gemini-3-flash-preview"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 0.5,
        outputPrice: 3.0,
        cacheReadsPrice: 0.05,
        cacheWritesPrice: 0.0,
        temperature: 0.35,
        thinkingConfig: {
            geminiThinkingLevel: "high" as const,
            supportsThinkingLevel: true,
        },
    },
    "claude-sonnet-4-6": {
        ...MODEL_CAPABILITIES["claude-sonnet-4-6"],
        supportsPromptCache: true,
        inputPrice: 3.0,
        outputPrice: 15.0,
        cacheWritesPrice: 3.75,
        cacheReadsPrice: 0.3,
    },
    "claude-sonnet-4-6:1m": {
        ...MODEL_CAPABILITIES["claude-sonnet-4-6:1m"],
        supportsPromptCache: true,
        inputPrice: 3.0,
        outputPrice: 15.0,
        cacheWritesPrice: 3.75,
        cacheReadsPrice: 0.3,
        tiers: CLAUDE_SONNET_1M_TIERS,
    },
    "claude-haiku-4-5@20251001": {
        ...MODEL_CAPABILITIES["claude-haiku-4-5-20251001"],
        supportsImages: false,
        supportsPromptCache: true,
        inputPrice: 1.0,
        outputPrice: 5.0,
        cacheWritesPrice: 1.25,
        cacheReadsPrice: 0.1,
    },
    "claude-opus-4-6": {
        ...MODEL_CAPABILITIES["claude-opus-4-6"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 5.0,
        outputPrice: 25.0,
        cacheWritesPrice: 6.25,
        cacheReadsPrice: 0.5,
    },
    "claude-opus-4-6:1m": {
        ...MODEL_CAPABILITIES["claude-opus-4-6:1m"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 5.0,
        outputPrice: 25.0,
        cacheWritesPrice: 6.25,
        cacheReadsPrice: 0.5,
        tiers: CLAUDE_OPUS_1M_TIERS,
    },
    "claude-opus-4-8": {
        ...MODEL_CAPABILITIES["claude-opus-4-8"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 5.0,
        outputPrice: 25.0,
        cacheWritesPrice: 6.25,
        cacheReadsPrice: 0.5,
    },
    "claude-opus-4-8:1m": {
        ...MODEL_CAPABILITIES["claude-opus-4-8:1m"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 5.0,
        outputPrice: 25.0,
        cacheWritesPrice: 6.25,
        cacheReadsPrice: 0.5,
        tiers: CLAUDE_OPUS_1M_TIERS,
    },
    "claude-fable-5": {
        ...MODEL_CAPABILITIES["claude-fable-5"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 10.0,
        outputPrice: 50.0,
        cacheWritesPrice: 12.5,
        cacheReadsPrice: 1.0,
    },
    "mistral-small-2503": {
        ...MODEL_CAPABILITIES["mistral-small-2503"],
        supportsPromptCache: false,
        inputPrice: 0.1,
        outputPrice: 0.3,
    },
    "codestral-2501": {
        ...MODEL_CAPABILITIES["codestral-2501"],
        supportsPromptCache: false,
        inputPrice: 0.3,
        outputPrice: 0.9,
    },
    "llama-4-maverick-17b-128e-instruct-maas": {
        ...MODEL_CAPABILITIES["llama-4-maverick-17b-128e-instruct-maas"],
        supportsPromptCache: false,
        inputPrice: 0.35,
        outputPrice: 1.15,
    },
    "llama-4-scout-17b-16e-instruct-maas": {
        ...MODEL_CAPABILITIES["llama-4-scout-17b-16e-instruct-maas"],
        supportsPromptCache: false,
        inputPrice: 0.25,
        outputPrice: 0.7,
    },
    "gemini-2.5-pro-exp-03-25": {
        ...MODEL_CAPABILITIES["gemini-2.5-pro-exp-03-25"],
        supportsPromptCache: false,
        inputPrice: 0,
        outputPrice: 0,
    },
    "gemini-2.5-pro": {
        ...MODEL_CAPABILITIES["gemini-2.5-pro"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 2.5,
        outputPrice: 15,
        cacheReadsPrice: 0.625,
        thinkingConfig: {
            maxBudget: 32767,
        },
        tiers: [
            {
                contextWindow: 200000,
                inputPrice: 1.25,
                outputPrice: 10,
                cacheReadsPrice: 0.31,
            },
            {
                contextWindow: Number.POSITIVE_INFINITY,
                inputPrice: 2.5,
                outputPrice: 15,
                cacheReadsPrice: 0.625,
            },
        ],
    },
    "gemini-2.5-flash": {
        ...MODEL_CAPABILITIES["gemini-2.5-flash"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 0.3,
        outputPrice: 2.5,
        thinkingConfig: {
            maxBudget: 24576,
            outputPrice: 3.5,
        },
    },
    "gemini-2.5-flash-lite-preview-06-17": {
        ...MODEL_CAPABILITIES["gemini-2.5-flash-lite-preview-06-17"],
        supportsPromptCache: true,
        supportsGlobalEndpoint: true,
        inputPrice: 0.1,
        outputPrice: 0.4,
        cacheReadsPrice: 0.025,
        description: "Preview version - may not be available in all regions",
        thinkingConfig: {
            maxBudget: 24576,
        },
    },
    "gemini-2.0-flash-thinking-exp-01-21": {
        ...MODEL_CAPABILITIES["gemini-2.0-flash-thinking-exp-01-21"],
        supportsPromptCache: false,
        supportsGlobalEndpoint: true,
        inputPrice: 0,
        outputPrice: 0,
    },
} as const satisfies Record<string, ModelInfo>

export const vertexGlobalModels: Record<string, ModelInfo> = Object.fromEntries(
    Object.entries(vertexModels).filter(([_k, v]) => Object.hasOwn(v, "supportsGlobalEndpoint"))
) as Record<string, ModelInfo>
