import fs from "node:fs/promises"
import path from "node:path"
import { ensureCacheDirectoryExists } from "@core/storage/disk"
import { ModelInfo } from "@shared/api"
import { fileExistsAtPath } from "@utils/fs"
import axios from "axios"
import { StateManager } from "@/core/storage/StateManager"
import { getAxiosSettings, isRateLimited } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

export interface FetchAndCacheModelsConfig {
	provider: string // StateManager cache key: "baseten", "groq", "openRouter", "vercel"
	cacheFileName: string // GlobalFileNames.xxx
	fetchUrl: string
	headers?: Record<string, string> // request headers (auth, content-type, etc.)
	parseResponse: (rawData: any) => Record<string, ModelInfo>
	staticModels?: () => Record<string, ModelInfo> // lazy fallback when fetch fails or no API key
	controller?: Controller // for readCacheFromController and onError hooks
	apiKey?: string // API key; if requiresAuth and falsy, skips fetch
	requiresAuth?: boolean // if true, apiKey must be non-empty to fetch
	validateApiKey?: (apiKey: string) => void // throw if key format is invalid
	providerLabel?: string // human-readable name for error messages: "Baseten", "Groq"
	postProcess?: (models: Record<string, ModelInfo>) => Record<string, ModelInfo> // e.g. append stealth models
	readCacheFromController?: (controller: Controller) => Promise<Record<string, ModelInfo> | undefined> // custom cache reader
	onError?: (error: any, errorMessage: string) => void // telemetry hook
}

// Track pending refresh promises per provider to prevent duplicate concurrent fetches
const pendingRefreshes = new Map<string, Promise<Record<string, ModelInfo>>>()

/**
 * Shared fetch-and-cache flow used by all model refreshers.
 * Handles: in-memory cache check, pending promise dedup, API fetch,
 * disk caching, error fallback (cache → static models), and StateManager storage.
 */
export function fetchAndCacheModels(config: FetchAndCacheModelsConfig): Promise<Record<string, ModelInfo>> {
	const { provider } = config

	// Check in-memory cache first
	const cache = StateManager.get().getModelsCache(provider)
	if (cache) return Promise.resolve(cache)

	// If a fetch is already in progress, return the same promise
	const pending = pendingRefreshes.get(provider)
	if (pending) return pending

	// Start new fetch and track the promise
	const promise = (async () => {
		try {
			return await doFetchAndCacheModels(config)
		} finally {
			pendingRefreshes.delete(provider)
		}
	})()

	pendingRefreshes.set(provider, promise)
	return promise
}

async function doFetchAndCacheModels(config: FetchAndCacheModelsConfig): Promise<Record<string, ModelInfo>> {
	const {
		provider,
		cacheFileName,
		fetchUrl,
		headers,
		parseResponse,
		staticModels,
		controller,
		apiKey,
		requiresAuth,
		validateApiKey,
		providerLabel,
		postProcess,
		readCacheFromController,
		onError,
	} = config

	const cacheFilePath = path.join(await ensureCacheDirectoryExists(), cacheFileName)
	const label = providerLabel || provider
	let models: Record<string, ModelInfo> = {}

	try {
		// Skip fetch if auth is required but no API key
		if (requiresAuth && !apiKey) throw new Error(`No ${label} API key set`)

		// Validate API key format if a key is provided
		if (apiKey && validateApiKey) validateApiKey(apiKey)

		const response = await axios.get(fetchUrl, {
			...(headers ? { headers } : {}),
			timeout: 10000,
			...getAxiosSettings(),
		})

		if (response.data?.data) {
			models = parseResponse(response.data.data)
			await fs.writeFile(cacheFilePath, JSON.stringify(models))
		} else {
			throw new Error(`Invalid response from ${label} API`)
		}
	} catch (error) {
		Logger.error(`Error fetching ${label} models:`, error)

		// Build descriptive error message and call telemetry hook
		const errorMessage = buildErrorMessage(error, label, !!providerLabel)
		if (providerLabel) Logger.error(`${label} API Error:`, errorMessage)
		if (onError) onError(error, errorMessage)

		// Try reading cached models from disk (or custom reader)
		const cachedModels =
			readCacheFromController && controller
				? await readCacheFromController(controller)
				: await readCachedModels(cacheFilePath)

		if (cachedModels && Object.keys(cachedModels).length > 0) {
			models = cachedModels
		} else if (staticModels) {
			models = staticModels()
		}
	}

	// Post-process (e.g. append stealth models)
	if (postProcess) models = postProcess(models)

	// Store in StateManager's in-memory cache
	StateManager.get().setModelsCache(provider, models)
	return models
}

function buildErrorMessage(error: any, label: string, detailed: boolean): string {
	if (!detailed) return error instanceof Error ? error.message : "Unknown error occurred"
	if (axios.isAxiosError(error)) {
		const status = error.response?.status ?? 0
		if (status === 401) return `Invalid ${label} API key. Please check your API key in settings.`
		if (status === 403) return `Access forbidden. Please verify your ${label} API key has the correct permissions.`
		if (isRateLimited(status)) return "Rate limit exceeded. Please try again later."
		if (error.code === "ECONNABORTED") return "Request timeout. Please check your internet connection."
		return `API request failed: ${error.response?.status || error.code || "Unknown error"}`
	}
	return error instanceof Error ? error.message : "Unknown error occurred"
}

async function readCachedModels(cacheFilePath: string): Promise<Record<string, ModelInfo> | undefined> {
	if (!(await fileExistsAtPath(cacheFilePath))) return undefined
	try {
		return JSON.parse(await fs.readFile(cacheFilePath, "utf8"))
	} catch (error) {
		Logger.error("Error reading cached models:", error)
		return undefined
	}
}
