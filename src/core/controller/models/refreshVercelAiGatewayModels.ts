import { GlobalFileNames } from "@core/storage/disk"
import { ModelInfo } from "@shared/api"
import { Controller } from ".."
import { fetchAndCacheModels } from "./fetchAndCacheModels"

/**
 * Derives thinkingConfig from model ID and tags.
 * The Vercel API only provides a "reasoning" tag to indicate support,
 * so we derive the specific configuration based on model patterns.
 */
function deriveThinkingConfig(modelId: string, tags?: string[]): ModelInfo["thinkingConfig"] {
	if (!tags?.includes("reasoning")) return undefined
	if (modelId.startsWith("anthropic/claude")) return { maxBudget: 8192 }
	if (modelId.includes("gemini-3")) return { maxBudget: 32767, supportsThinkingLevel: true, geminiThinkingLevel: "high" }
	if (modelId.startsWith("deepseek/deepseek-r1")) return { maxBudget: 8192 }
	if (modelId.startsWith("openai/o1") || modelId.startsWith("openai/o3")) return { maxBudget: 32000 }
	if (modelId === "qwen/qwq-32b:free" || modelId === "qwen/qwq-32b") return { maxBudget: 32000 }
	return { maxBudget: 32000 }
}

/** Derives recommended temperature for specific model types. Returns undefined to use the default (0). */
function deriveTemperature(modelId: string): number | undefined {
	if (
		modelId.startsWith("deepseek/deepseek-r1") ||
		modelId === "perplexity/sonar-reasoning" ||
		modelId === "qwen/qwq-32b:free" ||
		modelId === "qwen/qwq-32b"
	)
		return 0.7
	if (modelId.startsWith("google/gemini-3")) return 1.0
	return undefined
}

/**
 * Core function: Refreshes Vercel AI Gateway models and returns application types
 * @param _controller The controller instance (unused)
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshVercelAiGatewayModels(_controller: Controller): Promise<Record<string, ModelInfo>> {
	return fetchAndCacheModels({
		provider: "vercel",
		cacheFileName: GlobalFileNames.vercelAiGatewayModels,
		fetchUrl: "https://ai-gateway.vercel.sh/v1/models?include_mappings=true",
		parseResponse: parseVercelResponse,
	})
}

function parseVercelResponse(rawModels: any): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}
	const parsePrice = (price: any) => (price ? Number.parseFloat(price) * 1_000_000 : undefined)
	for (const rawModel of rawModels) {
		if (rawModel.type === "embedding") continue
		models[rawModel.id] = {
			maxTokens: rawModel.max_tokens ?? 0,
			contextWindow: rawModel.context_window ?? 0,
			inputPrice: parsePrice(rawModel.pricing?.input) ?? 0,
			outputPrice: parsePrice(rawModel.pricing?.output) ?? 0,
			cacheWritesPrice: parsePrice(rawModel.pricing?.input_cache_write) ?? 0,
			cacheReadsPrice: parsePrice(rawModel.pricing?.input_cache_read) ?? 0,
			supportsImages: true, // assume all models support images since vercel ai doesn't give this info
			supportsPromptCache: !!(rawModel.pricing?.input_cache_read && rawModel.pricing?.input_cache_write),
			description: rawModel.description ?? "",
			thinkingConfig: deriveThinkingConfig(rawModel.id, rawModel.tags),
			temperature: deriveTemperature(rawModel.id),
		}
	}
	return models
}
