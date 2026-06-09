import type { OpenAiCompatibleModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type GroqModelId = keyof typeof groqModels

export const groqDefaultModelId: GroqModelId = "openai/gpt-oss-20b"

export const groqModels = {
	"openai/gpt-oss-120b": {
		...MODEL_CAPABILITIES["gpt-oss-120b"],
		maxTokens: 32766, // Model fails if you try to use more than 32K tokens
		contextWindow: 131_072,
		supportsPromptCache: false,
		inputPrice: 0.15,
		outputPrice: 0.75,
		description:
			"A state-of-the-art 120B open-weight Mixture-of-Experts language model optimized for strong reasoning, tool use, and efficient deployment on large GPUs",
	},
	"openai/gpt-oss-20b": {
		...MODEL_CAPABILITIES["gpt-oss-20b"],
		maxTokens: 32766, // Model fails if you try to use more than 32K tokens
		contextWindow: 131_072,
		supportsPromptCache: false,
		inputPrice: 0.1,
		outputPrice: 0.5,
		description:
			"A compact 20B open-weight Mixture-of-Experts language model designed for strong reasoning and tool use, ideal for edge devices and local inference.",
	},
} as const satisfies Record<string, OpenAiCompatibleModelInfo>
