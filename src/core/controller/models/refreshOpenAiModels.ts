import { type ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { StringArray } from "@shared/proto/dirac/common"
import { OpenAiModelsRequest } from "@shared/proto/dirac/models"
import axios, { type AxiosRequestConfig, HttpStatusCode } from "axios"
import { StateManager } from "@/core/storage/StateManager"
import { getAxiosSettings, isAuthError } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const OPENAI_MODELS_TIMEOUT_MS = 5000

const OPENAI_MODELS_ERROR_MESSAGES: Record<number, string> = {
	[HttpStatusCode.Unauthorized]: "OpenAI-compatible /models endpoint rejected authentication (HTTP 401).",
	[HttpStatusCode.Forbidden]: "OpenAI-compatible /models endpoint rejected authentication (HTTP 403).",
	[HttpStatusCode.NotFound]: "Configured OpenAI-compatible provider does not support model discovery at /models.",
	[HttpStatusCode.MethodNotAllowed]: "Configured OpenAI-compatible provider does not support model discovery at /models.",
}

export interface OpenAiModelsFetchOptions {
	controller?: Controller
	baseUrl?: string
	apiKey?: string
	headers?: Record<string, string>
}

export interface OpenAiModelsErrorClassification {
	message: string
	isExpectedWarning: boolean
}

interface OpenAiRequestContext {
	customHeaders?: Record<string, string>
	fallbackApiKey?: string
	fallbackBaseUrl?: string
	setModelsCache?: (models: Record<string, ModelInfo>) => void
}

interface ResolvedOpenAiDiscoveryRequest {
	baseUrl: string
	headers: Record<string, string>
	shouldCacheModels: boolean
}

// Reads configured custom headers and fallback API key from StateManager when initialized.
function getOpenAiRequestContext(controller?: Controller): OpenAiRequestContext {
	// Without a controller, saved settings exist only once the StateManager singleton is initialised.
	const stateManager = controller?.stateManager ?? (StateManager.isInitialized() ? StateManager.get() : undefined)
	if (!stateManager) return {}
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
}

// Normalizes an OpenAI-compatible base URL by stripping trailing /chat/completions, /responses, and slashes.
export function normalizeOpenAiBaseUrl(rawBaseUrl?: string): string {
	const trimmed = rawBaseUrl?.trim() || ""
	if (!trimmed) return ""
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

// Purely classifies an OpenAI-compatible /models error into a user-facing message and severity flag.
export function classifyOpenAiModelsError(error: unknown): OpenAiModelsErrorClassification {
	if (axios.isAxiosError(error)) {
		const status = error.response?.status ?? 0
		const mappedMessage = OPENAI_MODELS_ERROR_MESSAGES[status]
		if (mappedMessage) {
			return { message: mappedMessage, isExpectedWarning: true }
		}
		if (isAuthError(status)) {
			return {
				message: `OpenAI-compatible /models endpoint rejected authentication (HTTP ${status}).`,
				isExpectedWarning: true,
			}
		}
	}
	return { message: "Model list unavailable; enter a custom model ID.", isExpectedWarning: false }
}

// Logs an OpenAI-compatible /models error using its classified severity.
export function logOpenAiModelsError(error: unknown): string {
	const { message, isExpectedWarning } = classifyOpenAiModelsError(error)
	if (isExpectedWarning) {
		Logger.warn(message)
	} else {
		Logger.error("Error fetching OpenAI models:", error)
	}
	return message
}

// Builds request headers from optional custom headers and an optional Bearer API key.
function buildDiscoveryHeaders(apiKey: string, customHeaders?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = { ...(customHeaders || {}) }
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`
	return headers
}

// Resolves endpoint and authentication as one coherent configuration without mixing explicit and saved credentials.
function resolveOpenAiDiscoveryRequest(
	options: OpenAiModelsFetchOptions,
	context: OpenAiRequestContext,
): ResolvedOpenAiDiscoveryRequest {
	const savedBaseUrl = normalizeOpenAiBaseUrl(context.fallbackBaseUrl)
	const savedApiKey = context.fallbackApiKey?.trim() ?? ""

	// Use the saved configuration as a whole only when no explicit endpoint or credentials are supplied.
	if (options.baseUrl === undefined && options.apiKey === undefined && options.headers === undefined) {
		return {
			baseUrl: savedBaseUrl,
			headers: buildDiscoveryHeaders(savedApiKey, context.customHeaders),
			shouldCacheModels: true,
		}
	}

	// Preserve intentional empty values; never fall back to savedBaseUrl when explicit options are provided.
	const baseUrl = normalizeOpenAiBaseUrl(options.baseUrl)
	const explicitApiKey = options.apiKey?.trim()
	// Saved key and headers may only be re-sent to the same saved endpoint with the same (or no explicit) key.
	const canReuseSavedAuth =
		Boolean(baseUrl && baseUrl === savedBaseUrl) &&
		(explicitApiKey === undefined || Boolean(explicitApiKey && explicitApiKey === savedApiKey))
	const apiKey = explicitApiKey ?? (canReuseSavedAuth ? savedApiKey : "")
	const customHeaders = options.headers ?? (canReuseSavedAuth ? context.customHeaders : undefined)

	return {
		baseUrl,
		headers: buildDiscoveryHeaders(apiKey, customHeaders),
		shouldCacheModels: canReuseSavedAuth && options.headers === undefined,
	}
}

// Fetches and caches OpenAI-compatible models as a Record<modelId, ModelInfo> for CLI and backend consumers.
export async function getOpenAiModels(options: OpenAiModelsFetchOptions = {}): Promise<Record<string, ModelInfo>> {
	const context = getOpenAiRequestContext(options.controller)
	const { baseUrl, headers, shouldCacheModels } = resolveOpenAiDiscoveryRequest(options, context)
	if (!baseUrl || !URL.canParse(baseUrl)) return {}

	const uniqueIds = await fetchOpenAiModelIds(baseUrl, headers)
	const models: Record<string, ModelInfo> = Object.fromEntries(uniqueIds.map((id) => [id, { ...openAiModelInfoSaneDefaults }]))
	if (shouldCacheModels && context.setModelsCache && uniqueIds.length > 0) context.setModelsCache(models)
	return models
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
	try {
		// Proto scalars/maps have empty defaults, so saved access needs an explicit
		// intent flag rather than treating an empty key or URL as omission.
		const models = await getOpenAiModels(request.useSavedEndpoint ? { controller } : {
			controller,
			baseUrl: request.baseUrl,
			apiKey: request.apiKey,
			headers: request.headers,
		})
		return StringArray.create({ values: Object.keys(models) })
	} catch (error) {
		logOpenAiModelsError(error)
		return StringArray.create({ values: [] })
	}
}
