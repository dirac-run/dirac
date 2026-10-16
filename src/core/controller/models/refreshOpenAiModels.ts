import { type ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { StringArray } from "@shared/proto/dirac/common"
import { OpenAiModelsRequest } from "@shared/proto/dirac/models"
import axios, { type AxiosRequestConfig, HttpStatusCode } from "axios"
import { StateManager } from "@/core/storage/StateManager"
import { getAxiosSettings, isAuthError } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const OPENAI_MODELS_TIMEOUT_MS = 5000

export interface OpenAiModelsFetchOptions {
	controller?: Controller
	baseUrl?: string
	apiKey?: string
}

// Reads configured custom headers and fallback API key from StateManager when initialized.
function getOpenAiRequestContext(controller?: Controller): {
	customHeaders?: Record<string, string>
	fallbackApiKey?: string
	fallbackBaseUrl?: string
	setModelsCache?: (models: Record<string, ModelInfo>) => void
} {
	try {
		const stateManager = controller?.stateManager ?? StateManager.get()
		const apiConfig = stateManager.getApiConfiguration()
		const customHeaders = stateManager.getGlobalSettingsKey("openAiHeaders")
		const fallbackApiKey = apiConfig.openAiCompatibleCustomApiKey || apiConfig.openAiApiKey
		const fallbackBaseUrl = apiConfig.openAiBaseUrl
		return {
			customHeaders,
			fallbackApiKey,
			fallbackBaseUrl,
			setModelsCache: (models) => stateManager.setModelsCache("openai", models),
		}
	} catch {
		return {}
	}
}

// Normalizes an OpenAI-compatible base URL by stripping trailing /chat/completions, /responses, and slashes.
export function normalizeOpenAiBaseUrl(rawBaseUrl?: string, hasApiKey = false): string {
	const trimmed = rawBaseUrl?.trim() || ""
	if (!trimmed) return hasApiKey ? DEFAULT_OPENAI_BASE_URL : ""
	return trimmed
		.replace(/\/chat\/completions\/?$/, "")
		.replace(/\/responses\/?$/, "")
		.replace(/\/+$/, "")
}

// Performs GET <baseUrl>/models and retries once against <baseUrl>/v1/models on 404 when /v1 was omitted.
async function fetchOpenAiModelIds(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
	const config: AxiosRequestConfig = {
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		timeout: OPENAI_MODELS_TIMEOUT_MS,
		...getAxiosSettings(),
	}
	let response: { data?: { data?: Array<{ id?: string }> } }
	try {
		response = await axios.get(`${baseUrl}/models`, config)
	} catch (firstError) {
		if (
			axios.isAxiosError(firstError) &&
			firstError.response?.status === HttpStatusCode.NotFound &&
			!baseUrl.endsWith("/v1")
		) {
			response = await axios.get(`${baseUrl}/v1/models`, config)
		} else {
			throw firstError
		}
	}
	const modelsArray = response.data?.data?.map((model) => model.id).filter((id): id is string => Boolean(id)) || []
	return [...new Set<string>(modelsArray)]
}

// Logs OpenAI-compatible /models discovery errors by HTTP status category (auth, unsupported endpoint, or unexpected).
function logOpenAiModelsError(error: unknown): void {
	if (axios.isAxiosError(error)) {
		const status = error.response?.status ?? 0
		if (isAuthError(status)) {
			Logger.warn(`OpenAI-compatible /models endpoint rejected authentication (HTTP ${status})`)
			return
		}
		if (status === HttpStatusCode.NotFound || status === HttpStatusCode.MethodNotAllowed) {
			Logger.warn("Configured OpenAI-compatible provider does not support model discovery at /models")
			return
		}
	}
	Logger.error("Error fetching OpenAI models:", error)
}

// Fetches and caches OpenAI-compatible models as a Record<modelId, ModelInfo> for CLI and backend consumers.
export async function getOpenAiModels(options: OpenAiModelsFetchOptions = {}): Promise<Record<string, ModelInfo>> {
	try {
		const context = getOpenAiRequestContext(options.controller)
		const apiKey = options.apiKey || context.fallbackApiKey || ""
		const baseUrl = normalizeOpenAiBaseUrl(options.baseUrl || context.fallbackBaseUrl, Boolean(apiKey))
		if (!baseUrl || !URL.canParse(baseUrl)) return {}

		const headers: Record<string, string> = { ...(context.customHeaders || {}) }
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`

		const uniqueIds = await fetchOpenAiModelIds(baseUrl, headers)
		const models: Record<string, ModelInfo> = Object.fromEntries(
			uniqueIds.map((id) => [id, { ...openAiModelInfoSaneDefaults }]),
		)
		if (context.setModelsCache && uniqueIds.length > 0) context.setModelsCache(models)
		return models
	} catch (error) {
		logOpenAiModelsError(error)
		return {}
	}
}

/**
 * Fetches available models from the OpenAI-compatible API for gRPC clients
 * @param controller The controller instance
 * @param request Request containing the base URL and API key
 * @returns Array of model names
 */
export async function refreshOpenAiModels(
	controller: Controller | undefined,
	request: OpenAiModelsRequest,
): Promise<StringArray> {
	const models = await getOpenAiModels({
		controller,
		baseUrl: request.baseUrl,
		apiKey: request.apiKey,
	})
	return StringArray.create({ values: Object.keys(models) })
}
