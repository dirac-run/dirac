import type { ModelInfo } from "./types"

export type QwenCodeModelId = keyof typeof qwenCodeModels
export const qwenCodeDefaultModelId: QwenCodeModelId = "qwen3.8-max"

// Compatibility choices when Qwen Code has not cached an account catalog yet.
// Availability and context limits are account-owned; do not advertise guessed
// token limits, token prices, image support, or free access for a subscription.
export const qwenCodeModels = {
	"qwen3.8-max": {
		supportsPromptCache: false,
		description: "Qwen3.8 Max (fallback ID). Account availability and subscription limits apply.",
	},
	"qwen4-max": {
		supportsPromptCache: false,
		description: "Qwen4 Max (fallback ID). Account availability and subscription limits apply.",
	},
	"qwen3.8-flash": {
		supportsPromptCache: false,
		description: "Qwen3.8 Flash (fallback ID). Account availability and subscription limits apply.",
	},
} as const satisfies Record<string, ModelInfo>
