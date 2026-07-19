import { GlobalFileNames } from "@core/storage/disk"
import type { ModelInfo } from "@shared/api"
import cloneDeep from "clone-deep"
import {
	ANTHROPIC_MAX_THINKING_BUDGET,
	CLAUDE_OPUS_1M_TIERS,
	CLAUDE_SONNET_1M_TIERS,
	openRouterClaudeOpus461mModelId,
	openRouterClaudeSonnet41mModelId,
	openRouterClaudeSonnet451mModelId,
	openRouterClaudeSonnet461mModelId,
} from "@/shared/api"
import type { Controller } from ".."
import { fetchAndCacheModels } from "./fetchAndCacheModels"

type OpenRouterSupportedParams =
	| "frequency_penalty"
	| "include_reasoning"
	| "logit_bias"
	| "logprobs"
	| "max_tokens"
	| "min_p"
	| "presence_penalty"
	| "reasoning"
	| "repetition_penalty"
	| "response_format"
	| "seed"
	| "stop"
	| "temperature"
	| "tool_choice"
	| "tools"
	| "top_k"
	| "top_logprobs"
	| "top_p"
	| "structured_outputs"
	| "parallel_tool_calls"

/**
 * The raw model information returned by the OpenRouter API to list models
 * @link https://openrouter.ai/docs/overview/models
 */
interface OpenRouterRawModelInfo {
	id: string
	name: string
	description: string | null
	context_length: number | null
	top_provider: {
		max_completion_tokens: number | null
		context_length: number | null
		is_moderated: boolean | null
	} | null
	architecture: {
		modality: string[]
		input_modalities: string[]
		output_modalities: string[]
		tokenizer: string
		instruct_type: string
	} | null
	pricing: {
		prompt: string
		completion: string
		request: string
		image: string
		audio: string
		internal_reasoning: string
		input_cache_read: string
		input_cache_write: string
	} | null
	supports_global_endpoint: boolean | null
	tiers: any[] | null
	supported_parameters?: OpenRouterSupportedParams[] | null
}

/**
 * Core function: Refreshes the OpenRouter models and returns application types
 * @param controller The controller instance
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshOpenRouterModels(controller: Controller): Promise<Record<string, ModelInfo>> {
	return fetchAndCacheModels({
		provider: "openRouter",
		cacheFileName: GlobalFileNames.openRouterModels,
		fetchUrl: "https://openrouter.ai/api/v1/models",
		parseResponse: parseOpenRouterResponse,
		controller,
		readCacheFromController: (ctrl) => ctrl.readOpenRouterModels(),
		postProcess: appendDiracStealthModels,
	})
}

function parseOpenRouterResponse(rawModels: OpenRouterRawModelInfo[]): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}
	const parsePrice = (price: any) => (price ? Number.parseFloat(price) * 1_000_000 : undefined)

	for (const rawModel of rawModels) {
		const supportThinking = rawModel.supported_parameters?.some((p) => p === "include_reasoning" || p === "reasoning")

		const modelInfo: ModelInfo = {
			name: rawModel.name,
			maxTokens: rawModel.top_provider?.max_completion_tokens ?? 0,
			contextWindow: rawModel.context_length ?? 0,
			supportsImages: rawModel.architecture?.modality?.includes("image") ?? false,
			supportsPromptCache: false,
			inputPrice: parsePrice(rawModel.pricing?.prompt) ?? 0,
			outputPrice: parsePrice(rawModel.pricing?.completion) ?? 0,
			cacheWritesPrice: parsePrice(rawModel.pricing?.input_cache_write),
			cacheReadsPrice: parsePrice(rawModel.pricing?.input_cache_read),
			description: rawModel.description ?? "",
			thinkingConfig: supportThinking ? { maxBudget: ANTHROPIC_MAX_THINKING_BUDGET } : undefined,
			// Strict Structured Outputs are only honored by OpenAI upstreams. Other providers
			// ignore `strict` and may reject the nullable-union schemas it requires.
			supportsStrictTools: rawModel.id.startsWith("openai/")
				? (rawModel.supported_parameters?.includes("structured_outputs") ?? undefined)
				: undefined,
			supportsGlobalEndpoint: rawModel.supports_global_endpoint ?? undefined,
			tiers: rawModel.tiers ?? undefined,
		}

		applyOpenRouterPricingOverrides(modelInfo, rawModel, parsePrice)
		models[rawModel.id] = modelInfo

		// Add custom :1m model variant for sonnet
		if (
			rawModel.id === "anthropic/claude-sonnet-4" ||
			rawModel.id === "anthropic/claude-sonnet-4.5" ||
			rawModel.id === "anthropic/claude-4.5-sonnet" ||
			rawModel.id === "anthropic/claude-sonnet-4.6" ||
			rawModel.id === "anthropic/claude-4.6-sonnet"
		) {
			const claudeSonnet1mModelInfo = cloneDeep(modelInfo)
			claudeSonnet1mModelInfo.contextWindow = 1_000_000
			claudeSonnet1mModelInfo.tiers = CLAUDE_SONNET_1M_TIERS
			if (rawModel.id === "anthropic/claude-sonnet-4") models[openRouterClaudeSonnet41mModelId] = claudeSonnet1mModelInfo
			if (rawModel.id === "anthropic/claude-sonnet-4.5" || rawModel.id === "anthropic/claude-4.5-sonnet")
				models[openRouterClaudeSonnet451mModelId] = claudeSonnet1mModelInfo
			if (rawModel.id === "anthropic/claude-sonnet-4.6" || rawModel.id === "anthropic/claude-4.6-sonnet")
				models[openRouterClaudeSonnet461mModelId] = claudeSonnet1mModelInfo
		}

		// Add custom :1m model variant for opus 4.6
		if (rawModel.id === "anthropic/claude-opus-4.6") {
			const claudeOpus1mModelInfo = cloneDeep(modelInfo)
			claudeOpus1mModelInfo.contextWindow = 1_000_000
			claudeOpus1mModelInfo.tiers = CLAUDE_OPUS_1M_TIERS
			models[openRouterClaudeOpus461mModelId] = claudeOpus1mModelInfo
		}
	}
	return models
}

/** Applies provider-specific pricing and context window overrides for known models */
function applyOpenRouterPricingOverrides(
	modelInfo: ModelInfo,
	rawModel: OpenRouterRawModelInfo,
	parsePrice: (price: any) => number | undefined,
): void {
	switch (rawModel.id) {
		case "anthropic/claude-sonnet-4.6":
		case "anthropic/claude-4.6-sonnet":
		case "anthropic/claude-sonnet-4.5":
		case "anthropic/claude-4.5-sonnet":
		case "anthropic/claude-sonnet-4":
			// NOTE: we artificially restrict the context window to 200k to keep costs low for users, and have a :1m model variant created below for users that want to use the full 1m.
			modelInfo.contextWindow = 200_000
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 3.75
			modelInfo.cacheReadsPrice = 0.3
			break
		case "anthropic/claude-3-7-sonnet":
		case "anthropic/claude-3-7-sonnet:beta":
		case "anthropic/claude-3.7-sonnet":
		case "anthropic/claude-3.7-sonnet:beta":
		case "anthropic/claude-3.7-sonnet:thinking":
		case "anthropic/claude-3.5-sonnet":
		case "anthropic/claude-3.5-sonnet:beta":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 3.75
			modelInfo.cacheReadsPrice = 0.3
			break
		case "anthropic/claude-opus-4.6":
			modelInfo.contextWindow = 200_000 // restrict to 200k, 1m variant created below
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 6.25
			modelInfo.cacheReadsPrice = 0.5
			break
		case "anthropic/claude-opus-4.5":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 6.25
			modelInfo.cacheReadsPrice = 0.5
			break
		case "anthropic/claude-opus-4.1":
		case "anthropic/claude-opus-4":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 18.75
			modelInfo.cacheReadsPrice = 1.5
			break
		case "anthropic/claude-3.5-sonnet-20240620":
		case "anthropic/claude-3.5-sonnet-20240620:beta":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 3.75
			modelInfo.cacheReadsPrice = 0.3
			break
		case "anthropic/claude-haiku-4.5":
		case "anthropic/claude-4.5-haiku":
		case "anthropic/claude-3-5-haiku":
		case "anthropic/claude-3-5-haiku:beta":
		case "anthropic/claude-3-5-haiku-20241022":
		case "anthropic/claude-3-5-haiku-20241022:beta":
		case "anthropic/claude-3.5-haiku":
		case "anthropic/claude-3.5-haiku:beta":
		case "anthropic/claude-3.5-haiku-20241022":
		case "anthropic/claude-3.5-haiku-20241022:beta":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 1.25
			modelInfo.cacheReadsPrice = 0.1
			break
		case "anthropic/claude-3-opus":
		case "anthropic/claude-3-opus:beta":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 18.75
			modelInfo.cacheReadsPrice = 1.5
			break
		case "anthropic/claude-3-haiku":
		case "anthropic/claude-3-haiku:beta":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 0.3
			modelInfo.cacheReadsPrice = 0.03
			break
		case "deepseek/deepseek-chat":
			modelInfo.supportsPromptCache = true
			modelInfo.inputPrice = 0
			modelInfo.cacheWritesPrice = 0.14
			modelInfo.cacheReadsPrice = 0.014
			break
		case "x-ai/grok-3-beta":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheWritesPrice = 0.75
			modelInfo.cacheReadsPrice = 0
			break
		case "moonshotai/kimi-k2":
			// forcing kimi-k2 to use the together provider for full context and best throughput
			modelInfo.inputPrice = 1
			modelInfo.outputPrice = 3
			modelInfo.contextWindow = 131_000
			break
		case "openai/gpt-5":
		case "openai/gpt-5-chat":
		case "openai/gpt-5-mini":
		case "openai/gpt-5-nano":
			modelInfo.maxTokens = 8_192 // 128000 breaks context window truncation
			modelInfo.contextWindow = 272_000 // openrouter reports 400k but the input limit is actually 400k-128k
			break
		case "x-ai/grok-code-fast-1":
			modelInfo.supportsPromptCache = true
			modelInfo.cacheReadsPrice = 0.02
			break
		default:
			if (rawModel.id.startsWith("openai/")) {
				modelInfo.cacheReadsPrice = parsePrice(rawModel.pricing?.input_cache_read)
				if (modelInfo.cacheReadsPrice) {
					modelInfo.supportsPromptCache = true
					modelInfo.cacheWritesPrice = parsePrice(rawModel.pricing?.input_cache_write)
					// openrouter charges no cache write pricing for openAI models
				}
			} else if (rawModel.id.startsWith("google/")) {
				modelInfo.cacheReadsPrice = parsePrice(rawModel.pricing?.input_cache_read)
				if (modelInfo.cacheReadsPrice) {
					modelInfo.supportsPromptCache = true
					modelInfo.cacheWritesPrice = parsePrice(rawModel.pricing?.input_cache_write)
				}
			}
			break
	}
}

/**
 * Stealth models are models that are compatible with the OpenRouter API but not listed on the OpenRouter website or API.
 */
const CLINE_STEALTH_MODELS: Record<string, ModelInfo> = {
	"stealth/giga-potato": {
		name: "Giga Potato",
		maxTokens: 8192,
		contextWindow: 224_000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 0,
		outputPrice: 0,
		description: "A stealth model for testing purposes. Not a real potato.",
	},
}

export function appendDiracStealthModels(currentModels: Record<string, ModelInfo>): Record<string, ModelInfo> {
	const cloned = { ...currentModels }
	for (const [modelId, modelInfo] of Object.entries(CLINE_STEALTH_MODELS)) {
		if (!cloned[modelId]) cloned[modelId] = modelInfo
	}
	return cloned
}
