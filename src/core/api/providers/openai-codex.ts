import { createHash } from "node:crypto"
import {
	ModelInfo,
	type OpenAiCodexModelId,
	type OpenAiCodexModelInfo,
	openAiCodexDefaultModelId,
	openAiCodexModels,
} from "@shared/api"
import { jsonHeaders } from "@shared/net"
import { resolveReasoningEffortForModel } from "@shared/utils/reasoning-support"
import OpenAI from "openai"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import * as os from "os"
import { v7 as uuidv7 } from "uuid"
import { openAiCodexUsageService } from "@/integrations/openai-codex/OpenAiCodexUsageService"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { featureFlagsService } from "@/services/feature-flags"
import { npmPackageVersion } from "@/shared/config/environment"
import { getErrorMessage } from "@/shared/errors"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiFormat } from "@/shared/proto/dirac/models"
import { FeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { Logger } from "@/shared/services/Logger"
import { isParallelToolCallingEnabled, supportsOpenAiPersistedReasoning } from "@/utils/model-utils"
import {
	type ApiConversationCompactionRequest,
	type ApiConversationCompactionResult,
	type ApiConversationRequestOptions,
	ApiHandler,
	CommonApiHandlerOptions,
} from "../"
import { RetriableError } from "../retry"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { ApiStream } from "../transform/stream"
import {
	getOpenAIServiceTier,
	parseSseResponse,
	processResponsesEvents,
	ResponsesWebsocketManager,
	shouldRetryWithFullContext,
} from "./openai-responses-utils"

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

interface CodexRequestBodyOptions {
	previousResponseId?: string
	usePersistedReasoning: boolean
	includeInferenceSpeed?: boolean
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
	private client?: OpenAI
	// Session ID for the Codex API (persists for the lifetime of the handler)
	private readonly sessionId: string
	// Abort controller for cancelling ongoing requests
	private abortController?: AbortController
	// Track tool call identity for streaming
	private pendingToolCallId: string | undefined
	private pendingToolCallName: string | undefined
	private websocketContinuationAnchor: { responseId: string; requestConfiguration: string } | undefined

	private isCurrentModelResponse(message: DiracStorageMessage, modelId: OpenAiCodexModelId): boolean {
		return (
			message.id?.startsWith("resp_") === true &&
			message.modelInfo?.providerId === "openai-codex" &&
			message.modelInfo.modelId === modelId
		)
	}

	private createRequestConfiguration(
		model: { id: OpenAiCodexModelId; info: OpenAiCodexModelInfo },
		systemPrompt: string,
		tools: CodexTool[],
		usePersistedReasoning: boolean,
	): string {
		return createHash("sha256")
			.update(
				JSON.stringify({
					model: model.id,
					instructions: systemPrompt,
					tools: tools.map((tool) => {
						if (tool.type === "function") {
							return {
								type: tool.type,
								name: tool.function.name,
								description: tool.function.description,
								parameters: tool.function.parameters,
								strict: tool.function.strict ?? true,
							}
						}
						return tool
					}),
					parallelToolCalls: this.shouldEnableParallelToolCalling(),
					inferenceSpeed: this.options.inferenceSpeed,
					reasoningEffort: resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort),
					usePersistedReasoning,
				}),
			)
			.digest("hex")
	}

	private canContinueWebsocketResponse(
		messages: DiracStorageMessage[],
		model: { id: OpenAiCodexModelId; info: OpenAiCodexModelInfo },
		requestConfiguration: string,
	): boolean {
		const anchor = this.websocketContinuationAnchor
		const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant")
		return (
			anchor !== undefined &&
			anchor.requestConfiguration === requestConfiguration &&
			latestAssistantMessage?.id === anchor.responseId &&
			this.isCurrentModelResponse(latestAssistantMessage, model.id)
		)
	}

	private recordWebsocketContinuationAnchor(responseId: string | undefined, requestConfiguration: string): void {
		if (!responseId?.startsWith("resp_")) {
			this.clearWebsocketContinuationAnchor("websocket_response_completed_without_id")
			return
		}
		this.websocketContinuationAnchor = { responseId, requestConfiguration }
	}

	private clearWebsocketContinuationAnchor(reason: string): void {
		this.websocketContinuationAnchor = undefined
	}

	constructor(options: OpenAiCodexHandlerOptions) {
		this.options = options
		this.sessionId = uuidv7()
	}

	supportsNativeWebSearch(): boolean {
		return true
	}

	private shouldEnableParallelToolCalling(): boolean {
		return isParallelToolCallingEnabled(this.options.enableParallelToolCalling ?? false)
	}

	private resolveServiceTier(modelInfo: ModelInfo) {
		const serviceTier = getOpenAIServiceTier(this.options.inferenceSpeed, "priority")
		if (serviceTier === "priority" && !modelInfo.supportsFastMode) {
			throw new Error("The selected Codex model does not support Fast mode")
		}
		return serviceTier
	}

	private createCodexClient(accessToken: string, headers: Record<string, string>): OpenAI {
		return new OpenAI({ apiKey: accessToken, baseURL: CODEX_API_BASE_URL, defaultHeaders: headers, fetch })
	}

	async compactConversation(request: ApiConversationCompactionRequest): Promise<ApiConversationCompactionResult> {
		const model = this.getModel()
		const usePersistedReasoning = supportsOpenAiPersistedReasoning(model.id, model.info.supportsPersistedReasoning)
		const finalTools: CodexTool[] = [...((request.tools ?? []) as ChatCompletionTool[])]
		const input = [...(request.checkpoint?.input ?? []), ...convertToOpenAIResponsesInput(request.messages).input]
		const fullBody = this.buildRequestBody(model, input, request.systemPrompt, finalTools, {
			usePersistedReasoning,
		})
		const { stream, store, tool_choice, include, previous_response_id, ...compactBody } = fullBody
		void stream
		void store
		void tool_choice
		void include
		void previous_response_id

		let accessToken = await openAiCodexOAuthManager.getAccessToken()
		if (!accessToken) {
			throw new Error("Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow in settings.")
		}

		this.abortController = new AbortController()
		const maxAttempts = this.options.disableRetries ? 1 : 2
		try {
			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				const accountId = await openAiCodexOAuthManager.getAccountId()
				const codexHeaders: Record<string, string> = {
					originator: "dirac",
					session_id: this.sessionId,
					"User-Agent": `dirac/${npmPackageVersion()} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
					...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
					...buildExternalBasicHeaders(),
				}
				const client = this.createCodexClient(accessToken, codexHeaders)
				try {
					const apiRequest = client.responses.compact(compactBody as any, {
						signal: this.abortController.signal,
						headers: codexHeaders,
					})
					const { data, response } = await apiRequest.withResponse()
					openAiCodexUsageService.applyResponseHeaders(response.headers)
					const output = (data as any).output
					if (!Array.isArray(output)) throw new Error("Codex compact response did not contain replacement input items")
					const opaqueItem = output.find((item: any) => item?.type === "compaction")
					if (!opaqueItem || typeof opaqueItem.encrypted_content !== "string") {
						throw new Error("Codex compact response did not contain opaque compaction state")
					}
					this.clearWebsocketContinuationAnchor("conversation_compacted")
					this.closeResponsesWebsocket()
					return { input: output }
				} catch (error) {
					const message = getErrorMessage(error)
					const isAuthFailure = /unauthorized|invalid token|not authenticated|authentication|401/i.test(message)
					if (!this.options.disableRetries && attempt === 0 && isAuthFailure) {
						const refreshed = await openAiCodexOAuthManager.forceRefreshAccessToken()
						if (!refreshed) throw error
						accessToken = refreshed
						continue
					}
					throw error
				}
			}
			throw new Error("Codex conversation compaction exhausted authentication retries")
		} finally {
			this.abortController = undefined
		}
	}

	async *createMessage(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools?: ChatCompletionTool[],
		options?: ApiConversationRequestOptions,
	): ApiStream {
		const finalTools: CodexTool[] = [...(tools || [])]
		if (options?.enableNativeWebSearch) finalTools.push({ type: "web_search" })
		const model = this.getModel()
		const usePersistedReasoning = supportsOpenAiPersistedReasoning(model.id, model.info.supportsPersistedReasoning)
		const useWebsocketMode = this.useWebsocketMode(model.info.apiFormat) || usePersistedReasoning

		this.pendingToolCallId = undefined
		this.pendingToolCallName = undefined

		if (options?.breakProviderContinuation) {
			this.clearWebsocketContinuationAnchor("conversation_compacted")
			this.closeResponsesWebsocket()
		}

		const requestConfiguration = this.createRequestConfiguration(model, systemPrompt, finalTools, usePersistedReasoning)
		const canContinue =
			!options?.breakProviderContinuation &&
			usePersistedReasoning &&
			this.canContinueWebsocketResponse(messages, model, requestConfiguration)
		const converted = convertToOpenAIResponsesInput(messages, {
			usePreviousResponseId: canContinue,
			canUsePreviousResponse: canContinue
				? (message) => message.id === this.websocketContinuationAnchor?.responseId
				: undefined,
		})
		const fullInput = [...(options?.checkpoint?.input ?? []), ...convertToOpenAIResponsesInput(messages).input]
		const input = converted.previousResponseId ? converted.input : fullInput
		const fallbackInput = fullInput
		let requestBody = this.buildRequestBody(model, input, systemPrompt, finalTools, {
			previousResponseId: converted.previousResponseId,
			usePersistedReasoning,
			includeInferenceSpeed: true,
		})
		const websocketFallbackRequestBody = this.buildRequestBody(model, fallbackInput, systemPrompt, finalTools, {
			usePersistedReasoning,
			includeInferenceSpeed: true,
		})
		const httpFallbackRequestBody = this.buildRequestBody(model, fallbackInput, systemPrompt, finalTools, {
			usePersistedReasoning,
			includeInferenceSpeed: true,
		})
		const functionCallOutputs = input.filter((item: any) => item.type === "function_call_output").length

		let accessToken = await openAiCodexOAuthManager.getAccessToken()
		if (!accessToken) {
			throw new Error("Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow in settings.")
		}

		const maxAttempts = this.options.disableRetries ? 1 : 2
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			let didEmitRequestOutput = false
			try {
				for await (const chunk of this.executeRequest(
					requestBody,
					websocketFallbackRequestBody,
					httpFallbackRequestBody,
					model,
					accessToken,
					useWebsocketMode,
					requestConfiguration,
				)) {
					didEmitRequestOutput = true
					yield chunk
				}
				return
			} catch (error) {
				const message = getErrorMessage(error)
				const isAuthFailure = /unauthorized|invalid token|not authenticated|authentication|401/i.test(message)
				if (!this.options.disableRetries && attempt === 0 && isAuthFailure && !didEmitRequestOutput) {
					const refreshed = await openAiCodexOAuthManager.forceRefreshAccessToken()
					if (!refreshed) {
						throw new Error(
							"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow in settings.",
						)
					}
					this.clearWebsocketContinuationAnchor("authentication_refreshed")
					this.closeResponsesWebsocket()
					requestBody = websocketFallbackRequestBody
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
		model: { id: string; info: OpenAiCodexModelInfo },
		formattedInput: any,
		systemPrompt: string,
		tools: CodexTool[] | undefined,
		options: CodexRequestBodyOptions,
	): any {
		const reasoningEffort = resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort)
		const includeReasoning = reasoningEffort !== undefined && reasoningEffort !== "none"
		const includeReasoningConfig = includeReasoning || options.usePersistedReasoning
		const serviceTier = options.includeInferenceSpeed ? this.resolveServiceTier(model.info) : undefined

		const body: any = {
			model: model.id,
			input: formattedInput,
			stream: true,
			// Codex OAuth chains response state through its WebSocket protocol; do not
			// opt ChatGPT accounts into standalone Responses API storage.
			store: false,
			instructions: systemPrompt,
			prompt_cache_key: this.sessionId,
			tool_choice: "auto",
			parallel_tool_calls: this.shouldEnableParallelToolCalling(),
			...(serviceTier ? { service_tier: serviceTier } : {}),
			...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
			...(includeReasoningConfig ? { include: ["reasoning.encrypted_content"] } : {}),
			...(includeReasoningConfig
				? {
					reasoning: {
						...(includeReasoning ? { effort: reasoningEffort } : {}),
						summary: "auto",
						...(options.usePersistedReasoning ? { context: "all_turns" } : {}),
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
		websocketFallbackRequestBody: any,
		httpFallbackRequestBody: any,
		model: { id: OpenAiCodexModelId; info: OpenAiCodexModelInfo },
		accessToken: string,
		useWebsocketMode: boolean,
		requestConfiguration: string,
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
				"User-Agent": `dirac/${npmPackageVersion()} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
				...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
				...buildExternalBasicHeaders(),
			}

			if (!useWebsocketMode) {
				yield* this.createResponseStreamHttp(requestBody, model, accessToken, codexHeaders)
				return
			}

			let didEmitWebsocketOutput = false
			let completedWebsocketResponseId: string | undefined
			try {
				for await (const chunk of this.createResponseStreamWebsocket(
					requestBody,
					accessToken,
					codexHeaders,
					model,
					(response) => {
						completedWebsocketResponseId = response.id
					},
				)) {
					if (chunk.type === "usage" && typeof chunk.id === "string") completedWebsocketResponseId = chunk.id
					didEmitWebsocketOutput = true
					yield chunk
				}
				this.recordWebsocketContinuationAnchor(completedWebsocketResponseId, requestConfiguration)
				return
			} catch (error) {
				if (this.options.disableRetries) {
					this.clearWebsocketContinuationAnchor("websocket_retry_disabled")
					this.closeResponsesWebsocket()
					throw error
				}

				if (!didEmitWebsocketOutput && shouldRetryWithFullContext(error, !!requestBody.previous_response_id)) {
					this.clearWebsocketContinuationAnchor("previous_response_not_found")
					Logger.log("Retrying Codex websocket response with full context after previous_response_not_found or 404")
					try {
						for await (const chunk of this.createResponseStreamWebsocket(
							websocketFallbackRequestBody,
							accessToken,
							codexHeaders,
							model,
							(response) => {
								completedWebsocketResponseId = response.id
							},
						)) {
							if (chunk.type === "usage" && typeof chunk.id === "string") completedWebsocketResponseId = chunk.id
							didEmitWebsocketOutput = true
							yield chunk
						}
						this.recordWebsocketContinuationAnchor(completedWebsocketResponseId, requestConfiguration)
						return
					} catch (retryError) {
						this.clearWebsocketContinuationAnchor("websocket_full_context_retry_failed")
						this.closeResponsesWebsocket()
						if (didEmitWebsocketOutput) throw retryError
						Logger.error(
							"OpenAI Codex websocket full-context retry failed, falling back to HTTP Responses API:",
							retryError,
						)
					}
				} else if (didEmitWebsocketOutput) {
					this.clearWebsocketContinuationAnchor("websocket_failed_after_output")
					this.closeResponsesWebsocket()
					throw error
				} else {
					Logger.error("OpenAI Codex websocket mode failed, falling back to HTTP Responses API:", error)
					this.clearWebsocketContinuationAnchor("websocket_failed")
					this.closeResponsesWebsocket()
				}
			}

			// The ChatGPT/Codex HTTP endpoint does not support previous_response_id.
			// Always use the full-context body when falling back from the websocket protocol.
			yield* this.createResponseStreamHttp(httpFallbackRequestBody, model, accessToken, codexHeaders)
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
		let didEmitSdkOutput = false
		try {
			const client =
				this.client ??
				new OpenAI({
					apiKey: accessToken,
					baseURL: CODEX_API_BASE_URL,
					defaultHeaders: codexHeaders,
					fetch, // Use shared fetch for proxy support
				})

			const request = client.responses.create(requestBody as OpenAI.Responses.ResponseCreateParamsStreaming, {
				signal: this.abortController?.signal,
				headers: codexHeaders,
			})
			const { data: stream, response } = await request.withResponse()
			openAiCodexUsageService.applyResponseHeaders(response.headers)

			if (typeof stream?.[Symbol.asyncIterator] !== "function") {
				throw new Error("OpenAI SDK did not return an AsyncIterable")
			}

			for await (const chunk of processResponsesEvents(stream, model.info, {
				onRateLimits: (event) => openAiCodexUsageService.applyRateLimitEvent(event),
			})) {
				didEmitSdkOutput = true
				yield chunk
			}
		} catch (_sdkErr) {
			if (_sdkErr instanceof Error && "headers" in _sdkErr && _sdkErr.headers instanceof Headers) {
				openAiCodexUsageService.applyResponseHeaders(_sdkErr.headers)
			}
			if (this.options.disableRetries) throw _sdkErr
			if (didEmitSdkOutput) throw _sdkErr
			// Server-side errors (429/overloaded/5xx) won't be helped by manual fetch — re-throw
			// so the error propagates to handleApiRequestError() which surfaces it to the user.
			if (_sdkErr instanceof Error) {
				const msg = _sdkErr.message.toLowerCase()
				if (
					msg.includes("overloaded") ||
					msg.includes("rate limit") ||
					msg.includes("too many requests") ||
					msg.includes("429")
				) {
					throw _sdkErr
				}
			}
			Logger.error("OpenAI Codex SDK request failed, falling back to manual fetch:", _sdkErr)
			// Fallback to manual SSE via fetch for SDK-specific errors
			yield* this.makeCodexRequest(requestBody, model, accessToken)
		}
	}
	private async *createResponseStreamWebsocket(
		primaryParams: OpenAI.Responses.ResponseCreateParamsStreaming,
		accessToken: string,
		codexHeaders: Record<string, string>,
		model: { id: string; info: ModelInfo },
		onResponseCompleted?: (response: { id?: string }) => void,
	): ApiStream {
		if (!this.responsesWsManager) {
			this.responsesWsManager = new ResponsesWebsocketManager({
				apiKey: accessToken,
				websocketUrl: CODEX_RESPONSES_WEBSOCKET_URL,
				extraHeaders: codexHeaders,
			})
		}

		yield* processResponsesEvents(this.responsesWsManager.createResponseEvents(primaryParams), model.info, {
			onRateLimits: (event) => openAiCodexUsageService.applyRateLimitEvent(event),
			onResponseCompleted,
		})
	}

	private closeResponsesWebsocket() {
		this.responsesWsManager?.close()
		this.responsesWsManager = undefined
	}
	private async *makeCodexRequest(requestBody: any, model: { id: string; info: ModelInfo }, accessToken: string): ApiStream {
		const url = `${CODEX_API_BASE_URL}/responses`
		const accountId = await openAiCodexOAuthManager.getAccountId()
		const headers: Record<string, string> = {
			...jsonHeaders(),
			Authorization: `Bearer ${accessToken}`,
			originator: "dirac",
			session_id: this.sessionId,
			"User-Agent": `dirac/${npmPackageVersion()} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
			...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
			...buildExternalBasicHeaders(),
		}

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: this.abortController?.signal,
		})
		openAiCodexUsageService.applyResponseHeaders(response.headers)

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "(unreadable)")
			Logger.error(`Codex API ${response.status} error body:`, errorBody)
			if (response.status === 429) {
				throw new RetriableError(`Codex API rate limited: ${response.status} - ${errorBody}`)
			}
			throw new Error(`Codex API request failed: ${response.status} - ${errorBody}`)
		}

		if (!response.body) {
			throw new Error("No response body from Codex API")
		}

		yield* processResponsesEvents(parseSseResponse(response.body), model.info, {
			onRateLimits: (event) => openAiCodexUsageService.applyRateLimitEvent(event),
		})
	}
	abort(): void {
		this.closeResponsesWebsocket()
		this.clearWebsocketContinuationAnchor("aborted")
		this.abortController?.abort()
	}

	getModel(): { id: OpenAiCodexModelId; info: OpenAiCodexModelInfo } {
		const modelId = this.options.apiModelId
		const id = modelId && modelId in openAiCodexModels ? (modelId as OpenAiCodexModelId) : openAiCodexDefaultModelId
		const info: OpenAiCodexModelInfo = openAiCodexModels[id]

		return { id, info: { ...info, supportsStrictTools: true } }
	}
}
