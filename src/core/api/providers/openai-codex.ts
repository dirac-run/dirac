import { ModelInfo, OpenAiCodexModelId, openAiCodexDefaultModelId, openAiCodexModels } from "@shared/api"
import { jsonHeaders } from "@shared/net"
import { normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import OpenAI from "openai"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import * as os from "os"
// Removed unused undici imports
import { v7 as uuidv7 } from "uuid"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { featureFlagsService } from "@/services/feature-flags"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiFormat } from "@/shared/proto/dirac/models"
import { FeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { ApiStream } from "../transform/stream"
import { parseSseResponse, processResponsesEvents, ResponsesWebsocketManager } from "./openai-responses-utils"

/**
 * OpenAI Codex base URL for API requests
 * Routes to chatgpt.com/backend-api/codex
 */
const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"
const CODEX_RESPONSES_WEBSOCKET_URL = "wss://chatgpt.com/backend-api/codex/responses"

// ChatCompletionTool doesn't include web_search; use the Responses API WebSearchTool shape
// external_web_access is not in the SDK type yet
type CodexWebSearchTool = OpenAI.Responses.WebSearchTool & { external_web_access?: boolean }
type CodexTool = ChatCompletionTool | CodexWebSearchTool

function isWebSearchTool(tool: CodexTool): tool is CodexWebSearchTool {
	return tool.type === "web_search" || tool.type === "web_search_2025_08_26"
}

interface OpenAiCodexHandlerOptions extends CommonApiHandlerOptions {
	reasoningEffort?: string
	apiModelId?: string
}

/**
 * OpenAiCodexHandler - Uses OpenAI Responses API with OAuth authentication
 *
 * Key differences from OpenAiNativeHandler:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Routes requests to Codex backend (chatgpt.com/backend-api/codex)
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset
 * - Custom headers for Codex backend
 */
export class OpenAiCodexHandler implements ApiHandler {
	private responsesWsManager: ResponsesWebsocketManager | undefined
	private options: OpenAiCodexHandlerOptions
	// Removed unused websocket state properties
	private client?: OpenAI
	// Session ID for the Codex API (persists for the lifetime of the handler)
	private readonly sessionId: string
	// Abort controller for cancelling ongoing requests
	private abortController?: AbortController
	// Track tool call identity for streaming
	private pendingToolCallId: string | undefined
	private pendingToolCallName: string | undefined

	constructor(options: OpenAiCodexHandlerOptions) {
		this.options = options
		this.sessionId = uuidv7()
	}

	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: ChatCompletionTool[]): ApiStream {
		// Add web_search tool for OpenAI
		const finalTools: CodexTool[] = [...(tools || []), { type: "web_search" }]
		const model = this.getModel()

		// Reset state for this request
		this.pendingToolCallId = undefined
		this.pendingToolCallName = undefined

		// Get access token from OAuth manager
		let accessToken = await openAiCodexOAuthManager.getAccessToken()
		if (!accessToken) {
			throw new Error("Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow in settings.")
		}
		const useWebsocketMode = this.useWebsocketMode(model.info.apiFormat)
		const { input } = convertToOpenAIResponsesInput(messages, { usePreviousResponseId: false })

		// Build request body
		const requestBody = this.buildRequestBody(model, input, systemPrompt, finalTools)

		// Make the request with retry on auth failure
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				yield* this.executeRequest(requestBody, model, accessToken, useWebsocketMode)
				return
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const isAuthFailure = /unauthorized|invalid token|not authenticated|authentication|401/i.test(message)

				if (attempt === 0 && isAuthFailure) {
					// Force refresh the token for retry
					const refreshed = await openAiCodexOAuthManager.forceRefreshAccessToken()
					if (!refreshed) {
						throw new Error(
							"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow in settings.",
						)
					}
					accessToken = refreshed
					continue
				}
				throw error
			}
		}
	}

	private useWebsocketMode(apiFormat?: ApiFormat): boolean {
		if (featureFlagsService.getBooleanFlagEnabled(FeatureFlag.OPENAI_RESPONSES_WEBSOCKET_MODE)) {
			return apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
		}
		return false
	}

	private buildRequestBody(
		model: { id: string; info: ModelInfo },
		formattedInput: any,
		systemPrompt: string,
		tools?: CodexTool[],
	): any {
		// Determine reasoning effort
		const reasoningEffort = normalizeOpenaiReasoningEffort(this.options.reasoningEffort)
		const includeReasoning = reasoningEffort !== "none"

		const body: any = {
			model: model.id,
			input: formattedInput,
			stream: true,
			store: false,
			instructions: systemPrompt,
			prompt_cache_key: this.sessionId,
			tool_choice: "auto",
			parallel_tool_calls: false,
			...(includeReasoning ? { include: ["reasoning.encrypted_content"] } : {}),
			...(includeReasoning
				? {
					reasoning: {
						effort: reasoningEffort,
						summary: "auto",
					},
				}
				: {}),
		}

		// Add tools if provided
		// Pass through strict value from tool (custom tools have strict: false, built-in tools default to true)
		if (tools && tools.length > 0) {
			body.tools = tools
				.map((tool) => {
					if (tool.type === "function") {
						return {
							type: "function",
							name: tool.function.name,
							description: tool.function.description,
							parameters: tool.function.parameters,
							strict: tool.function.strict ?? true,
						}
					}
					if (isWebSearchTool(tool)) {
						return {
							type: "web_search",
							...(tool.search_context_size ? { search_context_size: tool.search_context_size } : {}),
							...(tool.filters ? { filters: tool.filters } : {}),
							...(tool.user_location ? { user_location: tool.user_location } : {}),
							...(tool.external_web_access !== undefined ? { external_web_access: tool.external_web_access } : {}),
						}
					}
					return undefined
				})
				.filter(Boolean)
		}

		return body
	}

	private async *executeRequest(
		requestBody: any,
		model: { id: string; info: ModelInfo },
		accessToken: string,
		useWebsocketMode: boolean,
	): ApiStream {
		// Create AbortController for cancellation
		this.abortController = new AbortController()

		try {
			// Get ChatGPT account ID for organization subscriptions
			const accountId = await openAiCodexOAuthManager.getAccountId()

			// Build Codex-specific headers
			const codexHeaders: Record<string, string> = {
				originator: "dirac",
				session_id: this.sessionId,
				"User-Agent": `dirac/${process.env.npm_package_version || "1.0.0"} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
				...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
				...buildExternalBasicHeaders(),
			}

			if (useWebsocketMode) {
				try {
					yield* this.createResponseStreamWebsocket(requestBody, accessToken, codexHeaders, model)
					return
				} catch (error) {
					Logger.error("OpenAI Codex websocket mode failed, falling back to HTTP Responses API:", error)
					this.closeResponsesWebsocket()
				}
			}

			// Try HTTP request (SDK first, then fetch)
			yield* this.createResponseStreamHttp(requestBody, model, accessToken, codexHeaders)
		} finally {
			this.abortController = undefined
		}
	}

	private async *createResponseStreamHttp(
		requestBody: any,
		model: { id: string; info: ModelInfo },
		accessToken: string,
		codexHeaders: Record<string, string>,
	): ApiStream {
		// Try using OpenAI SDK first
		try {
			const client =
				this.client ??
				new OpenAI({
					apiKey: accessToken,
					baseURL: CODEX_API_BASE_URL,
					defaultHeaders: codexHeaders,
					fetch, // Use shared fetch for proxy support
				})

			const stream = await client.responses.create(requestBody as OpenAI.Responses.ResponseCreateParamsStreaming, {
				signal: this.abortController?.signal,
				headers: codexHeaders,
			})

			if (typeof stream?.[Symbol.asyncIterator] !== "function") {
				throw new Error("OpenAI SDK did not return an AsyncIterable")
			}

			yield* processResponsesEvents(stream, model.info)
		} catch (_sdkErr) {
			Logger.error("OpenAI Codex SDK request failed, falling back to manual fetch:", _sdkErr)
			// Fallback to manual SSE via fetch
			yield* this.makeCodexRequest(requestBody, model, accessToken)
		}
	}
	private async *createResponseStreamWebsocket(
		primaryParams: OpenAI.Responses.ResponseCreateParamsStreaming,
		accessToken: string,
		codexHeaders: Record<string, string>,
		model: { id: string; info: ModelInfo },
	): ApiStream {
		if (!this.responsesWsManager) {
			this.responsesWsManager = new ResponsesWebsocketManager({
				apiKey: accessToken,
				websocketUrl: CODEX_RESPONSES_WEBSOCKET_URL,
				extraHeaders: codexHeaders,
			})
		}

		try {
			yield* processResponsesEvents(this.responsesWsManager.createResponseEvents(primaryParams), model.info)
		} catch (error) {
			throw error
		}
	}

	private closeResponsesWebsocket() {
		this.responsesWsManager?.close()
	}
	private async *makeCodexRequest(requestBody: any, model: { id: string; info: ModelInfo }, accessToken: string): ApiStream {
		const url = `${CODEX_API_BASE_URL}/responses`
		const accountId = await openAiCodexOAuthManager.getAccountId()
		const headers: Record<string, string> = {
			...jsonHeaders(),
			Authorization: `Bearer ${accessToken}`,
			originator: "dirac",
			session_id: this.sessionId,
			"User-Agent": `dirac/${process.env.npm_package_version || "1.0.0"} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
			...buildExternalBasicHeaders(),
		}

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: this.abortController?.signal,
		})

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "(unreadable)")
			Logger.error(`Codex API ${response.status} error body:`, errorBody)
			throw new Error(`Codex API request failed: ${response.status} - ${errorBody}`)
		}

		if (!response.body) {
			throw new Error("No response body from Codex API")
		}

		yield* processResponsesEvents(parseSseResponse(response.body), model.info)
	}
	abort(): void {
		this.responsesWsManager?.close()
		// Removed unused closeResponsesWebsocket call
		this.abortController?.abort()
	}

	getModel(): { id: OpenAiCodexModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId

		const id = modelId && modelId in openAiCodexModels ? (modelId as OpenAiCodexModelId) : openAiCodexDefaultModelId

		const info: ModelInfo = openAiCodexModels[id]

		return { id, info: { ...info, supportsStrictTools: true } }
	}
}
