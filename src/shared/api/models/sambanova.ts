import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type SambanovaModelId = keyof typeof sambanovaModels

export const sambanovaDefaultModelId: SambanovaModelId = "Meta-Llama-3.3-70B-Instruct"

export const sambanovaModels = {
    "DeepSeek-R1-0528": {
        ...MODEL_CAPABILITIES["DeepSeek-R1-0528"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 5.0,
        outputPrice: 7.0,
    },
    "DeepSeek-R1-Distill-Llama-70B": {
        ...MODEL_CAPABILITIES["DeepSeek-R1-Distill-Llama-70B"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 0.7,
        outputPrice: 1.4,
    },
    "DeepSeek-V3-0324": {
        ...MODEL_CAPABILITIES["DeepSeek-V3-0324"],
        supportsPromptCache: false,
        temperature: 0.3,
        inputPrice: 3.0,
        outputPrice: 4.5,
    },
    "DeepSeek-V3.1": {
        ...MODEL_CAPABILITIES["DeepSeek-V3.1"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 3.0,
        outputPrice: 4.5,
    },
    "DeepSeek-V3.1-Terminus": {
        ...MODEL_CAPABILITIES["DeepSeek-V3.1-Terminus"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 3.0,
        outputPrice: 4.5,
    },
    "Llama-4-Maverick-17B-128E-Instruct": {
        ...MODEL_CAPABILITIES["llama-4-maverick-17b-128e-instruct"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 0.63,
        outputPrice: 1.8,
    },
    "Meta-Llama-3.1-8B-Instruct": {
        ...MODEL_CAPABILITIES["Meta-Llama-3.1-8B-Instruct"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 0.1,
        outputPrice: 0.2,
    },
    "Meta-Llama-3.3-70B-Instruct": {
        ...MODEL_CAPABILITIES["Meta-Llama-3.3-70B-Instruct"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 0.6,
        outputPrice: 1.2,
    },
    "Qwen3-235B": {
        ...MODEL_CAPABILITIES["Qwen3-235B"],
        supportsPromptCache: false,
        temperature: 0.7,
        inputPrice: 0.4,
        outputPrice: 0.8,
    },
    "Qwen3-32B": {
        ...MODEL_CAPABILITIES["Qwen3-32B"],
        supportsPromptCache: false,
        temperature: 0.6,
        inputPrice: 0.4,
        outputPrice: 0.8,
    },
} as const satisfies Record<string, ModelInfo>
