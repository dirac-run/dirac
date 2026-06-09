import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type GeminiModelId = keyof typeof geminiModels

export const geminiDefaultModelId: GeminiModelId = "gemini-3.1-pro-preview"

export const geminiModels = {
	"gemini-3.1-pro-preview": {
		...MODEL_CAPABILITIES["gemini-3.1-pro-preview"],
		maxTokens: 65536,
		supportsPromptCache: true,
		inputPrice: 4.0,
		outputPrice: 18.0,
		cacheReadsPrice: 0.4,
		thinkingConfig: {
			// If you don't specify a thinking level, Gemini will use the model's default
			// dynamic thinking level, "high", for Gemini 3 Pro Preview.
			geminiThinkingLevel: "high" as const,
			supportsThinkingLevel: true,
		},
		tiers: [
			{
				contextWindow: 200000,
				inputPrice: 2.0,
				outputPrice: 12.0,
				cacheReadsPrice: 0.2,
			},
			{
				contextWindow: Number.POSITIVE_INFINITY,
				inputPrice: 4.0,
				outputPrice: 18.0,
				cacheReadsPrice: 0.4,
			},
		],
	},
	"gemini-3-pro-preview": {
		...MODEL_CAPABILITIES["gemini-3-pro-preview"],
		maxTokens: 65536,
		supportsPromptCache: true,
		inputPrice: 4.0,
		outputPrice: 18.0,
		cacheReadsPrice: 0.4,
		thinkingConfig: {
			geminiThinkingLevel: "high" as const,
			supportsThinkingLevel: true,
		},
		tiers: [
			{
				contextWindow: 200000,
				inputPrice: 2.0,
				outputPrice: 12.0,
				cacheReadsPrice: 0.2,
			},
			{
				contextWindow: Number.POSITIVE_INFINITY,
				inputPrice: 4.0,
				outputPrice: 18.0,
				cacheReadsPrice: 0.4,
			},
		],
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
			geminiThinkingLevel: "low" as const,
			supportsThinkingLevel: true,
		},
	},
	"gemini-2.5-pro": {
		...MODEL_CAPABILITIES["gemini-2.5-pro"],
		supportsPromptCache: true,
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
	"gemini-2.5-flash": {
		...MODEL_CAPABILITIES["gemini-2.5-flash"],
		supportsPromptCache: true,
		inputPrice: 0.3,
		outputPrice: 2.5,
		cacheReadsPrice: 0.075,
		thinkingConfig: {
			maxBudget: 24576,
			outputPrice: 3.5,
		},
	},
} as const satisfies Record<string, ModelInfo>
