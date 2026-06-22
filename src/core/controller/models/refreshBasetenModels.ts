import { GlobalFileNames } from "@core/storage/disk"
import { ANTHROPIC_MAX_THINKING_BUDGET, ModelInfo } from "@shared/api"
import { jsonHeaders } from "@shared/net"
import { parsePrice } from "@utils/model-utils"
import { basetenModels } from "../../../shared/api"
import { Controller } from ".."
import { fetchAndCacheModels } from "./fetchAndCacheModels"

/**
 * Core function: Refreshes the Baseten models and returns application types
 * @param controller The controller instance
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshBasetenModels(controller: Controller): Promise<Record<string, ModelInfo>> {
	const apiKey = controller.stateManager.getSecretKey("basetenApiKey")?.trim()
	return fetchAndCacheModels({
		provider: "baseten",
		cacheFileName: GlobalFileNames.basetenModels,
		fetchUrl: "https://inference.baseten.co/v1/models",
		headers: { Authorization: `Bearer ${apiKey}`, ...jsonHeaders(), "User-Agent": "Dirac-VSCode-Extension" },
		requiresAuth: true,
		apiKey,
		providerLabel: "Baseten",
		parseResponse: parseBasetenResponse,
		staticModels: getBasetenStaticModels,
	})
}

function parseBasetenResponse(rawModels: any): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}
	if (!rawModels || !Array.isArray(rawModels)) return models
	for (const rawModel of rawModels) {
		if (!isValidChatModel(rawModel)) continue
		const staticModelInfo = basetenModels[rawModel.id as keyof typeof basetenModels]
		const supportThinking = rawModel?.supported_features?.some((p: string) => p === "reasoning_effort" || p === "reasoning")
		models[rawModel.id] = {
			maxTokens: (rawModel.max_completion_tokens || staticModelInfo?.maxTokens) ?? 8192,
			contextWindow: (rawModel.context_length || staticModelInfo?.contextWindow) ?? 8192,
			supportsImages: false, // Baseten model APIs does not support image input
			supportsPromptCache: staticModelInfo?.supportsPromptCache || false,
			inputPrice: parsePrice(rawModel.pricing?.prompt) || staticModelInfo?.inputPrice || 0,
			outputPrice: parsePrice(rawModel.pricing?.completion) || staticModelInfo?.outputPrice || 0,
			cacheWritesPrice: staticModelInfo?.cacheWritesPrice || 0,
			cacheReadsPrice: staticModelInfo?.cacheReadsPrice || 0,
			description: generateModelDescription(rawModel, staticModelInfo),
			supportsReasoning: supportThinking || false,
			thinkingConfig: supportThinking ? { maxBudget: ANTHROPIC_MAX_THINKING_BUDGET } : undefined,
		}
	}
	return models
}

function getBasetenStaticModels(): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}
	for (const [modelId, modelInfo] of Object.entries(basetenModels)) {
		models[modelId] = {
			maxTokens: modelInfo.maxTokens,
			contextWindow: modelInfo.contextWindow,
			supportsImages: modelInfo.supportsImages,
			supportsPromptCache: modelInfo.supportsPromptCache,
			inputPrice: modelInfo.inputPrice,
			outputPrice: modelInfo.outputPrice,
			cacheWritesPrice: modelInfo.cacheWritesPrice || 0,
			cacheReadsPrice: modelInfo.cacheReadsPrice || 0,
			description: modelInfo.description || `${modelId} model`,
			supportsReasoning: modelInfo.supportsReasoning || false,
			thinkingConfig: modelInfo.supportsReasoning ? { maxBudget: ANTHROPIC_MAX_THINKING_BUDGET } : undefined,
		}
	}
	return models
}

/** Validates if a model is suitable for chat completions */
function isValidChatModel(rawModel: any): boolean {
	if (rawModel.id.includes("whisper") || rawModel.id.includes("tts") || rawModel.id.includes("embedding")) return false
	return rawModel.object === "model" && !!rawModel.id
}

/** Generates a descriptive name for the model */
function generateModelDescription(rawModel: any, staticModelInfo?: any): string {
	if (staticModelInfo?.description) return staticModelInfo.description
	if (rawModel.description) {
		const contextWindow = rawModel.context_length
		const quantization = rawModel.quantization
		const features = rawModel.supported_features || []
		let description = rawModel.description
		const technicalDetails = []
		if (contextWindow) technicalDetails.push(`${contextWindow.toLocaleString()} token context`)
		if (quantization) technicalDetails.push(`${quantization} precision`)
		if (features.length > 0) technicalDetails.push(`supports ${features.join(", ")}`)
		if (technicalDetails.length > 0) description += ` (${technicalDetails.join(", ")})`
		return description
	}
	const modelName = rawModel.name || rawModel.id
	const contextWindow = rawModel.context_length
	const ownedBy = rawModel.owned_by || "Baseten"
	return contextWindow
		? `${ownedBy} ${modelName} with ${contextWindow.toLocaleString()} token context window`
		: `${ownedBy} model: ${modelName}`
}
