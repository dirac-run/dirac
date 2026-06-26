import { GlobalFileNames } from "@core/storage/disk"
import { ModelInfo } from "@shared/api"
import { jsonHeaders } from "@shared/net"
import axios from "axios"
import { telemetryService } from "@/services/telemetry"
import { groqModels } from "../../../shared/api"
import { Controller } from ".."
import { fetchAndCacheModels } from "./fetchAndCacheModels"

/**
 * Core function: Refreshes the Groq models and returns application types
 * @param controller The controller instance
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshGroqModels(controller: Controller): Promise<Record<string, ModelInfo>> {
	const apiKey = controller.stateManager.getSecretKey("groqApiKey")?.trim()
	return fetchAndCacheModels({
		provider: "groq",
		cacheFileName: GlobalFileNames.groqModels,
		fetchUrl: "https://api.groq.com/openai/v1/models",
		headers: { Authorization: `Bearer ${apiKey}`, ...jsonHeaders(), "User-Agent": "Dirac-VSCode-Extension" },
		requiresAuth: true,
		apiKey,
		providerLabel: "Groq",
		validateApiKey: (key) => {
			if (!key.startsWith("gsk_")) throw new Error("Invalid Groq API key format. Groq API keys should start with 'gsk_'")
		},
		parseResponse: parseGroqResponse,
		staticModels: getGroqStaticModels,
		controller,
		onError: (error, errorMessage) => {
			telemetryService.captureProviderApiError({
				ulid: controller.task?.ulid || "",
				errorMessage,
				errorStatus: axios.isAxiosError(error) ? error.status : undefined,
				model: "groq",
			})
		},
	})
}

function parseGroqResponse(rawModels: any): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}
	for (const rawModel of rawModels) {
		if (!isValidChatModel(rawModel)) continue
		const staticModelInfo: ModelInfo | undefined = groqModels[rawModel.id as keyof typeof groqModels]
		models[rawModel.id] = {
			maxTokens: rawModel.max_completion_tokens || staticModelInfo?.maxTokens || 8192,
			contextWindow: rawModel.context_window || staticModelInfo?.contextWindow || 8192,
			supportsImages: detectImageSupport(rawModel, staticModelInfo),
			supportsPromptCache: staticModelInfo?.supportsPromptCache || false,
			inputPrice: staticModelInfo?.inputPrice || 0,
			outputPrice: staticModelInfo?.outputPrice || 0,
			cacheWritesPrice: staticModelInfo?.cacheWritesPrice || 0,
			cacheReadsPrice: staticModelInfo?.cacheReadsPrice || 0,
			description: generateModelDescription(rawModel, staticModelInfo),
		}
	}
	return models
}

function getGroqStaticModels(): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}
	for (const [modelId, modelInfo] of Object.entries(groqModels) as [string, ModelInfo][]) {
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
		}
	}
	return models
}

/** Validates if a model is suitable for chat completions */
function isValidChatModel(rawModel: any): boolean {
	if (Object.hasOwn(rawModel, "active") && !rawModel.active) return false
	if (["whisper", "tts", "guard", "embedding", "moderation", "allam"].some((s) => rawModel.id.includes(s))) return false
	return rawModel.object === "model" && !!rawModel.id
}

/** Detects if a model supports image input */
function detectImageSupport(rawModel: any, staticModelInfo?: any): boolean {
	if (staticModelInfo?.supportsImages !== undefined) return staticModelInfo.supportsImages
	const modelId = rawModel.id.toLowerCase()
	return modelId.includes("vision") || modelId.includes("maverick") || modelId.includes("scout")
}

/** Generates a descriptive name for the model */
function generateModelDescription(rawModel: any, staticModelInfo?: any): string {
	if (staticModelInfo?.description) return staticModelInfo.description
	const modelId = rawModel.id
	const contextWindow = rawModel.context_window || 8192
	const ownedBy = rawModel.owned_by || "Unknown"
	if (modelId.includes("compound"))
		return `${ownedBy}'s ${modelId} model with ${contextWindow.toLocaleString()} token context window - Advanced compound architecture`
	return `${ownedBy} model with ${contextWindow.toLocaleString()} token context window`
}
