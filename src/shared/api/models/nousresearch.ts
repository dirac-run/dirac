import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type NousResearchModelId = keyof typeof nousResearchModels

export const nousResearchDefaultModelId: NousResearchModelId = "Hermes-4-405B"

export const nousResearchModels = {
	"Hermes-4-405B": {
		...MODEL_CAPABILITIES["Hermes-4-405B"],
		supportsPromptCache: false,
		inputPrice: 0.09,
		outputPrice: 0.37,
		description:
			"This is the largest model in the Hermes 4 family, and it is the fullest expression of our design, focused on advanced reasoning and creative depth rather than optimizing inference speed or cost.",
	},
	"Hermes-4-70B": {
		...MODEL_CAPABILITIES["Hermes-4-70B"],
		supportsPromptCache: false,
		inputPrice: 0.05,
		outputPrice: 0.2,
		description:
			"This incarnation of Hermes 4 balances scale and size. It handles complex reasoning tasks, while staying fast and cost effective. A versatile choice for many use cases.",
	},
} as const satisfies Record<string, ModelInfo>
