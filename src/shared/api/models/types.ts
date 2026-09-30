import { ApiFormat } from "../../proto/dirac/models"
import type { OpenaiReasoningEffort } from "../../storage/types"
import type { LanguageModelChatSelector } from "../../vsCodeSelectorUtils"

export interface PriceTier {
	tokenLimit: number
	price: number
}

export interface ModelPricing {
	inputPrice?: number
	outputPrice?: number
	cacheWritesPrice?: number
	cacheReadsPrice?: number
}

export type UtcWeekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday"

export interface PricingSchedulePeriod {
	label: string
	weekdays: readonly UtcWeekday[]
	startMinuteUtc: number
	endMinuteUtc: number
	prices: ModelPricing
}

export interface ModelPricingSchedule {
	timeZone: "UTC"
	defaultLabel: string
	periods: readonly PricingSchedulePeriod[]
}

/**
 * Model-intrinsic capabilities that don't vary across providers.
 * These describe what a model CAN do, not how much it costs.
 */
export interface ModelCapabilities {
	name?: string
	canonicalSlug?: string
	maxTokens?: number
	contextWindow?: number
	supportsImages?: boolean
	supportsReasoning?: boolean
	supportsReasoningEffort?: boolean
	reasoningEffortOptions?: OpenaiReasoningEffort[]
	defaultReasoningEffort?: OpenaiReasoningEffort
	supportsAdaptiveThinking?: boolean
	thinkingAlwaysOn?: boolean
	supportsForcedToolUse?: boolean
	supportsTools?: boolean
	supportsStrictTools?: boolean
	description?: string
	thinkingConfig?: {
		maxBudget?: number
		geminiThinkingLevel?: "low" | "medium" | "high"
		supportsThinkingLevel?: boolean
	}
}

export interface ModelInfo extends ModelCapabilities, ModelPricing {
	supportsPromptCache: boolean
	supportsFastMode?: boolean
	fastModePriceMultiplier?: number
	pricingSchedule?: ModelPricingSchedule
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
		geminiThinkingLevel?: "low" | "medium" | "high"
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

export interface ModelProviderPreset {
	id: string
	provider: import("../../api").ApiProvider
	modelId: string
	modelInfo?: ModelInfo
	openAiProfileName?: string
	vsCodeLmModelSelector?: LanguageModelChatSelector
	awsBedrockCustomSelected?: boolean
	awsBedrockCustomModelBaseId?: string
	lastUsedAt: number
}

/**
 * Copies the reusable provider/model identity from a preset without preserving
 * preset identity or usage metadata.
 */
export function createModelProviderSelection(preset: ModelProviderPreset): ModelProviderSelection {
	return {
		provider: preset.provider,
		modelId: preset.modelId,
		modelInfo: preset.modelInfo,
		openAiProfileName: preset.openAiProfileName,
		vsCodeLmModelSelector: preset.vsCodeLmModelSelector,
		awsBedrockCustomSelected: preset.awsBedrockCustomSelected,
		awsBedrockCustomModelBaseId: preset.awsBedrockCustomModelBaseId,
	}
}

/**
 * Secret-free provider and model identity for an independently configured model.
 * It intentionally excludes credentials and Plan/Act state.
 */
export interface ModelProviderSelection {
	provider: import("../../api").ApiProvider
	modelId: string
	modelInfo?: ModelInfo
	openAiProfileName?: string
	vsCodeLmModelSelector?: LanguageModelChatSelector
	awsBedrockCustomSelected?: boolean
	awsBedrockCustomModelBaseId?: string
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
	reasoningEffortOptions: OpenaiReasoningEffort[]
}

export interface LiteLLMModelInfo extends ModelInfo {
	temperature?: number
}

export interface BasetenModelInfo extends ModelInfo {
	supportedFeatures?: string[]
}

// True when the model has any pricing data (even $0); false when pricing is unknown.
export function hasPricing(modelInfo: ModelInfo): boolean {
	const prices = [
		modelInfo.inputPrice,
		modelInfo.outputPrice,
		modelInfo.cacheWritesPrice,
		modelInfo.cacheReadsPrice,
		...(modelInfo.pricingSchedule?.periods.flatMap((period) => [
			period.prices.inputPrice,
			period.prices.outputPrice,
			period.prices.cacheWritesPrice,
			period.prices.cacheReadsPrice,
		]) ?? []),
	]
	return prices.some((price) => price !== undefined)
}

// True only when base prices are explicitly zero and no pricing override can add a charge.
export function isFreeModel(modelInfo: ModelInfo): boolean {
	if (modelInfo.inputPrice !== 0 || modelInfo.outputPrice !== 0) return false

	const overridePrices = [
		modelInfo.cacheWritesPrice,
		modelInfo.cacheReadsPrice,
		modelInfo.thinkingConfig?.outputPrice,
		...(modelInfo.pricingSchedule?.periods.flatMap((period) => [
			period.prices.inputPrice,
			period.prices.outputPrice,
			period.prices.cacheWritesPrice,
			period.prices.cacheReadsPrice,
		]) ?? []),
		...(modelInfo.tiers?.flatMap((tier) => [
			tier.inputPrice,
			tier.outputPrice,
			tier.cacheWritesPrice,
			tier.cacheReadsPrice,
		]) ?? []),
		...(modelInfo.thinkingConfig?.outputPriceTiers?.map((tier) => tier.price) ?? []),
	]

	return overridePrices.every((price) => price === undefined || price === 0)
}
