import { ApiFormat } from "../../proto/dirac/models"

export interface PriceTier {
	tokenLimit: number
	price: number
}

/**
 * Model-intrinsic capabilities that don't vary across providers.
 * These describe what a model CAN do, not how much it costs.
 */
export interface ModelCapabilities {
	name?: string
	maxTokens?: number
	contextWindow?: number
	supportsImages?: boolean
	supportsReasoning?: boolean
	supportsAdaptiveThinking?: boolean
	supportsTools?: boolean
	supportsStrictTools?: boolean
	description?: string
	thinkingConfig?: {
		maxBudget?: number
		geminiThinkingLevel?: "low" | "high"
		supportsThinkingLevel?: boolean
	}
}

export interface ModelInfo extends ModelCapabilities {
	supportsPromptCache: boolean
	inputPrice?: number
	outputPrice?: number
	cacheWritesPrice?: number
	cacheReadsPrice?: number
	supportsGlobalEndpoint?: boolean
	tiers?: {
		contextWindow: number
		inputPrice?: number
		outputPrice?: number
		cacheWritesPrice?: number
		cacheReadsPrice?: number
	}[]
	temperature?: number
	apiFormat?: ApiFormat
	thinkingConfig?: {
		maxBudget?: number
		outputPrice?: number
		outputPriceTiers?: PriceTier[]
		geminiThinkingLevel?: "low" | "high"
		supportsThinkingLevel?: boolean
	}
}

export interface OpenAiCompatibleProfile {
	name: string
	baseUrl: string
	apiKey?: string
	modelId: string
	modelInfo: OpenAiCompatibleModelInfo
	headers?: Record<string, string>
	azureApiVersion?: string
}

export interface OpenAiCompatibleModelInfo extends ModelInfo {
	temperature?: number
	isR1FormatRequired?: boolean
	systemRole?: "developer" | "system"
	supportsReasoningEffort?: boolean
	supportsStreaming?: boolean
}

export interface OcaModelInfo extends OpenAiCompatibleModelInfo {
	modelName: string
	surveyId?: string
	banner?: string
	surveyContent?: string
	supportsReasoning?: boolean
	reasoningEffortOptions: string[]
}

export interface LiteLLMModelInfo extends ModelInfo {
	temperature?: number
}

export interface BasetenModelInfo extends ModelInfo {
	supportedFeatures?: string[]
}
