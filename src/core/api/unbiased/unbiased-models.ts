import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { type ModelInfo, unbiasedModels } from "@shared/api"
import axios, { type AxiosRequestConfig } from "axios"
import { Logger } from "@/shared/services/Logger"

export interface UnbiasedModelsCache {
	getModelsCache(key: string): Record<string, ModelInfo> | null
	setModelsCache(key: string, models: Record<string, ModelInfo>): void
}

export interface UnbiasedModelDiscoveryOptions {
	cache: UnbiasedModelsCache
	cacheFilePath(): Promise<string>
	fileExists(path: string): Promise<boolean>
	axiosSettings: Pick<AxiosRequestConfig, "adapter"> & { fetch?: typeof globalThis.fetch }
}

interface UnbiasedRawModel {
	id: string
	name?: string
	description?: string
	context_length?: number
	top_provider?: { max_completion_tokens?: number }
	architecture?: { input_modalities?: string[] }
	pricing?: {
		prompt?: string
		completion?: string
		input_cache_read?: string
		input_cache_write?: string
	}
	supported_parameters?: string[]
}

const pendingRequests = new Map<string, Promise<Record<string, ModelInfo>>>()

// A different key must fetch its own catalog, without storing the credential in a cache key.
function modelsCacheKey(apiKey: string): string {
	return `unbiased:${createHash("sha256").update(apiKey).digest("hex")}`
}

export function getCachedUnbiasedModels(
	apiKey: string | undefined,
	cache: UnbiasedModelsCache | undefined,
): Record<string, ModelInfo> | undefined {
	if (!apiKey || !cache) return undefined
	return cache.getModelsCache(modelsCacheKey(apiKey)) ?? undefined
}

export function fetchUnbiasedModels(
	apiKey: string | undefined,
	options: UnbiasedModelDiscoveryOptions,
): Promise<Record<string, ModelInfo>> {
	// Do not cache an unauthenticated fallback: signing in must trigger discovery.
	if (!apiKey) return Promise.resolve(unbiasedModels)
	const cached = getCachedUnbiasedModels(apiKey, options.cache)
	if (cached) return Promise.resolve(cached)

	const cacheKey = modelsCacheKey(apiKey)
	const pending = pendingRequests.get(cacheKey)
	if (pending) return pending

	const request = fetchAndCacheUnbiasedModels(apiKey, cacheKey, options).finally(() => pendingRequests.delete(cacheKey))
	pendingRequests.set(cacheKey, request)
	return request
}

async function fetchAndCacheUnbiasedModels(
	apiKey: string,
	cacheKey: string,
	options: UnbiasedModelDiscoveryOptions,
): Promise<Record<string, ModelInfo>> {
	const cacheFilePath = await options.cacheFilePath()
	let models: Record<string, ModelInfo>
	try {
		const response = await axios.get<{ data: UnbiasedRawModel[] }>("https://api.unbiased.ai/v1/models", {
			headers: { Authorization: `Bearer ${apiKey}` },
			timeout: 10_000,
			...options.axiosSettings,
		})
		if (!Array.isArray(response.data?.data) || !response.data.data.length) {
			throw new Error("Unbiased returned no models")
		}
		models = parseUnbiasedModels(response.data.data)
		await fs.writeFile(cacheFilePath, JSON.stringify(models))
	} catch (error) {
		// Never log an Axios error object: it contains the Authorization header.
		const status = axios.isAxiosError(error) ? error.response?.status : undefined
		Logger.warn(`Unbiased model discovery failed${status ? ` (HTTP ${status})` : ""}; using cached or default metadata.`)
		models = (await options.fileExists(cacheFilePath)) ? JSON.parse(await fs.readFile(cacheFilePath, "utf8")) : unbiasedModels
	}
	options.cache.setModelsCache(cacheKey, models)
	return models
}

function parseUnbiasedModels(rawModels: UnbiasedRawModel[]): Record<string, ModelInfo> {
	return Object.fromEntries(
		rawModels.map((model) => {
			const parameters = new Set(model.supported_parameters)
			const cacheReadsPrice = parseUnbiasedPrice(model.pricing?.input_cache_read)
			const cacheWritesPrice = parseUnbiasedPrice(model.pricing?.input_cache_write)
			const supportsReasoning = parameters.has("reasoning") || parameters.has("include_reasoning")
			const info: ModelInfo = {
				name: model.name,
				description: model.description,
				contextWindow: model.context_length,
				maxTokens: model.top_provider?.max_completion_tokens,
				supportsImages: model.architecture?.input_modalities?.includes("image") ?? false,
				supportsTools: parameters.has("tools"),
				supportsStrictTools: parameters.has("structured_outputs"),
				supportsReasoning,
				supportsReasoningEffort: parameters.has("reasoning"),
				thinkingConfig: supportsReasoning ? {} : undefined,
				supportsPromptCache: cacheReadsPrice !== undefined || cacheWritesPrice !== undefined,
				inputPrice: parseUnbiasedPrice(model.pricing?.prompt),
				outputPrice: parseUnbiasedPrice(model.pricing?.completion),
				cacheReadsPrice,
				cacheWritesPrice,
			}
			return [model.id, info]
		}),
	)
}

function parseUnbiasedPrice(price: string | undefined): number | undefined {
	if (price == null || price === "") return undefined
	const parsed = Number(price)
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Unbiased returned invalid pricing")
	return parsed * 1_000_000
}
