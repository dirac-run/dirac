import type { OpenAiCompatibleModelInfo } from "./types"
import { ApiFormat } from "../../proto/dirac/models"
import { MODEL_CAPABILITIES } from "./capabilities"
import { GPT_5_5_TIERS, GPT_5_4_TIERS, GPT_5_4_PRO_TIERS } from "./shared-tiers"

export type OpenAiNativeModelId = keyof typeof openAiNativeModels

export const openAiNativeDefaultModelId: OpenAiNativeModelId = "gpt-5.4"

export const openAiNativeModels = {
    "gpt-5.5": {
        ...MODEL_CAPABILITIES["gpt-5.5"],
        supportsPromptCache: true,
        inputPrice: 5.0,
        outputPrice: 30.0,
        cacheReadsPrice: 0.5,
        cacheWritesPrice: 0,
        apiFormat: ApiFormat.OPENAI_RESPONSES,
        tiers: GPT_5_5_TIERS,
    },
    "gpt-5.4": {
        ...MODEL_CAPABILITIES["gpt-5.4"],
        supportsPromptCache: true,
        inputPrice: 2.5,
        outputPrice: 15,
        cacheReadsPrice: 0.25,
        cacheWritesPrice: 0,
        apiFormat: ApiFormat.OPENAI_RESPONSES,
        tiers: GPT_5_4_TIERS,
    },
    "gpt-5.4-mini": {
        ...MODEL_CAPABILITIES["gpt-5.4-mini"],
        supportsPromptCache: true,
        inputPrice: 0.75,
        outputPrice: 4.5,
        cacheReadsPrice: 0.075,
        cacheWritesPrice: 0,
        apiFormat: ApiFormat.OPENAI_RESPONSES,
    },
    "gpt-5.4-nano": {
        ...MODEL_CAPABILITIES["gpt-5.4-nano"],
        supportsPromptCache: true,
        inputPrice: 0.2,
        outputPrice: 1.25,
        cacheReadsPrice: 0.02,
        cacheWritesPrice: 0,
        apiFormat: ApiFormat.OPENAI_RESPONSES,
    },
    "gpt-5.4-pro": {
        ...MODEL_CAPABILITIES["gpt-5.4-pro"],
        supportsPromptCache: true,
        inputPrice: 30,
        outputPrice: 180,
        cacheReadsPrice: 0,
        cacheWritesPrice: 0,
        apiFormat: ApiFormat.OPENAI_RESPONSES,
        tiers: GPT_5_4_PRO_TIERS,
    },
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
