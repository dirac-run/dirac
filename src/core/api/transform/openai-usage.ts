import { ModelInfo } from "@shared/api"
import { ApiStreamUsageChunk } from "./stream"
import { calculateApiCostOpenAI } from "@/utils/cost"

/**
 * Formats usage data from OpenAI-compatible providers into a standardized chunk,
 * accounting for caching and calculating total cost.
 */
export function formatOpenAiCompatibleUsage(
	usage: {
		prompt_tokens?: number
		completion_tokens?: number
		prompt_tokens_details?: {
			cached_tokens?: number
			cache_write_tokens?: number
		}
		prompt_cache_hit_tokens?: number
		prompt_cache_miss_tokens?: number
		cost?: number
		[key: string]: any
	},
	modelInfo: ModelInfo,
	overrides?: {
		cacheReadTokens?: number
		cacheWriteTokens?: number
	},
): ApiStreamUsageChunk {
	const totalInputTokens = usage.prompt_tokens || 0
	const outputTokens = usage.completion_tokens || 0

	// Resolve cache read tokens (checking multiple possible field names)
	const cacheReadTokens =
		overrides?.cacheReadTokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0

	// Resolve cache write tokens (checking multiple possible field names)
	const cacheWriteTokens =
		overrides?.cacheWriteTokens ?? usage.prompt_tokens_details?.cache_write_tokens ?? usage.prompt_cache_miss_tokens ?? 0

	// Prefer provider-reported cost (e.g. OpenRouter) or calculate locally
	const totalCost =
		usage.cost ?? calculateApiCostOpenAI(modelInfo, totalInputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)

	return {
		type: "usage",
		inputTokens: Math.max(0, totalInputTokens - cacheReadTokens),
		outputTokens: outputTokens,
		cacheReadTokens: cacheReadTokens,
		cacheWriteTokens: cacheWriteTokens,
		totalCost: totalCost,
	}
}
