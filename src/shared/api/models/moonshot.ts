import type { OpenAiCompatibleModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type MoonshotModelId = keyof typeof moonshotModels
export const moonshotDefaultModelId = "kimi-k3" satisfies MoonshotModelId

export const moonshotModels = {
	"kimi-k3": {
		...MODEL_CAPABILITIES["kimi-k3"],
		supportsPromptCache: true,
		inputPrice: 3.0,
		outputPrice: 15.0,
		cacheReadsPrice: 0.3,
		isR1FormatRequired: true,
	},
	"kimi-k2.6": {
		...MODEL_CAPABILITIES["kimi-k2.6"],
		supportsPromptCache: true,
		inputPrice: 0.95,
		outputPrice: 4.0,
		cacheReadsPrice: 0.16,
		temperature: 1.0,
		isR1FormatRequired: true,
	},
	"kimi-k2.5": {
		...MODEL_CAPABILITIES["kimi-k2.5"],
		supportsPromptCache: true,
		inputPrice: 0.6,
		outputPrice: 3.0,
		cacheReadsPrice: 0.1,
		temperature: 1.0,
		isR1FormatRequired: true,
	},
	"kimi-k2-0905-preview": {
		...MODEL_CAPABILITIES["kimi-k2-0905-preview"],
		supportsPromptCache: false,
		inputPrice: 0.6,
		outputPrice: 2.5,
		temperature: 0.6,
		isR1FormatRequired: true,
	},
	"kimi-k2-thinking-turbo": {
		...MODEL_CAPABILITIES["kimi-k2-thinking-turbo"],
		supportsPromptCache: false,
		inputPrice: 2.4,
		outputPrice: 10,
		temperature: 1.0,
		isR1FormatRequired: true,
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
