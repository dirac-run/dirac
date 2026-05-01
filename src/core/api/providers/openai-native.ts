import {
	ModelInfo,
	OpenAiCompatibleModelInfo,
	OpenAiNativeModelId,
	openAiNativeDefaultModelId,
	openAiNativeModels,
} from "@shared/api"
import { normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import {
	buildResponseCreateParams,
	mapResponseTools,
	processResponsesEvents,
	ResponsesWebsocketManager,
	shouldRetryWithFullContext
} from "./openai-responses-utils"
import type {
	ChatCompletionReasoningEffort,
	ChatCompletionTool,
} from "openai/resources/chat/completions"
// Removed unused undici imports
import { featureFlagsService } from "@/services/feature-flags"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiFormat } from "@/shared/proto/dirac/models"
import { FeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { Logger } from "@/shared/services/Logger"
import { isGPT5 } from "@/utils/model-utils"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

interface OpenAiNativeHandlerOptions extends CommonApiHandlerOptions {
	openAiNativeApiKey?: string
	reasoningEffort?: string
	thinkingBudgetTokens?: number
	apiModelId?: string
	openAiNativeUseResponsesWebsocket?: boolean
}

export class OpenAiNativeHandler implements ApiHandler {
	private responsesWsManager: ResponsesWebsocketManager | undefined
	private options: OpenAiNativeHandlerOptions
	private client: OpenAI | undefined
	// Removed unused websocket state properties
	private abortController?: AbortController
	private getResponsesWsManager(): ResponsesWebsocketManager {
		if (!this.responsesWsManager) {
			this.responsesWsManager = new ResponsesWebsocketManager({
				apiKey: this.options.openAiNativeApiKey || "",
			})
		}
		return this.responsesWsManager
	}

	private useWebsocketMode(apiFormat?: ApiFormat): boolean {
		if (featureFlagsService.getBooleanFlagEnabled(FeatureFlag.OPENAI_RESPONSES_WEBSOCKET_MODE)) {
			return apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE
		}
		return false
	}
	constructor(options: OpenAiNativeHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.openAiNativeApiKey) {
				throw new Error("OpenAI API key is required")
			}
			try {
				this.client = createOpenAIClient({
					apiKey: this.options.openAiNativeApiKey,
				})
			} catch (error) {
				throw new Error(`Error creating OpenAI client: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return this.client
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		const inputTokens = usage?.prompt_tokens || 0 // sum of cache hits and misses
		const outputTokens = usage?.completion_tokens || 0
		const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || 0
		const cacheWriteTokens = 0
		const totalCost = calculateApiCostOpenAI(info, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
		const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
		yield {
			type: "usage",
			inputTokens: nonCachedInputTokens,
			outputTokens: outputTokens,
			cacheWriteTokens: cacheWriteTokens,
			cacheReadTokens: cacheReadTokens,
			totalCost: totalCost,
		}
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: ChatCompletionTool[]): ApiStream {
		// Add web_search tool for OpenAI
		const finalTools = [...(tools || [])]
		finalTools.push({ type: "web_search" } as any)
		// Responses API requires tool format to be set to OPENAI_RESPONSES with native tools calling enabled
		const apiFormat = this.getModel()?.info?.apiFormat
		if (apiFormat === ApiFormat.OPENAI_RESPONSES || apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE) {
			if (!tools?.length) {
				throw new Error("Native Tool Call must be enabled in your setting for OpenAI Responses API")
			}
			yield* this.createResponseStream(systemPrompt, messages, finalTools)
		} else {
			yield* this.createCompletionStream(systemPrompt, messages, finalTools)
		}
	}

	private async *createCompletionStream(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools?: ChatCompletionTool[],
	): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const toolCallProcessor = new ToolCallProcessor()
		this.abortController = new AbortController()

		// Handle o1 models separately as they don't support streaming
		if (model.info.supportsStreaming === false) {
			const response = await client.chat.completions.create(
				{
					model: model.id,
					messages: [{ role: "user", content: systemPrompt }, ...convertToOpenAiMessages(messages, "openai-native")],
				},
				{ signal: this.abortController?.signal },
			)
			yield {
				type: "text",
				text: response.choices[0]?.message.content || "",
			}
			yield* this.yieldUsage(model.info, response.usage)
			return
		}

		const systemRole = model.info.systemRole ?? "system"
		const includeReasoning = model.info.supportsReasoningEffort
		const includeTools = model.info.supportsTools ?? true
		const requestedEffort = normalizeOpenaiReasoningEffort(this.options.reasoningEffort)
		const reasoningEffort =
			includeReasoning && requestedEffort !== "none" ? (requestedEffort as ChatCompletionReasoningEffort) : undefined

		const stream = await client.chat.completions.create({
			model: model.id,
			messages: [{ role: systemRole, content: systemPrompt }, ...convertToOpenAiMessages(messages, "openai-native")],
			stream: true,
			stream_options: { include_usage: true },
			reasoning_effort: reasoningEffort,
			...(model.info.temperature !== undefined ? { temperature: model.info.temperature } : {}),
			...(includeTools ? getOpenAIToolParams(tools, isGPT5(model.id)) : {}),
		})

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta?.tool_calls) {
				try {
					yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
				} catch (error) {
					Logger.error("Error processing tool call delta:", error, delta.tool_calls)
				}
			}

			if (chunk.usage) {
				// Only last chunk contains usage
				yield* this.yieldUsage(model.info, chunk.usage)
			}
		}
	}

	private async *createResponseStream(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools: ChatCompletionTool[],
	): ApiStream {
		const model = this.getModel()
		const usePreviousResponseId = this.useWebsocketMode(model.info.apiFormat)

		if (usePreviousResponseId) {
			this.getResponsesWsManager()
				.ensureWebsocket()
				.catch((error) => {
					Logger.debug("OpenAI websocket preconnect failed:", error)
				})
		}

		const { input, previousResponseId } = convertToOpenAIResponsesInput(messages, { usePreviousResponseId })
		const responseTools = mapResponseTools(tools)
		this.abortController = new AbortController()

		const params = buildResponseCreateParams({
			modelId: model.id,
			systemPrompt,
			input,
			previousResponseId,
			tools: responseTools,
			reasoningEffort: this.options.reasoningEffort,
		})

		const fallbackParams = buildResponseCreateParams({
			modelId: model.id,
			systemPrompt,
			input,
			tools: responseTools,
			reasoningEffort: this.options.reasoningEffort,
		})

		if (usePreviousResponseId && previousResponseId) {
			try {
				try {
					const wsManager = this.getResponsesWsManager()
					yield* processResponsesEvents(wsManager.createResponseEvents(params), model.info)
					return
				} catch (error) {
					if (shouldRetryWithFullContext(error, !!params.previous_response_id)) {
						Logger.log("Retrying websocket response with full context after previous_response_not_found or socket reset")
						this.responsesWsManager?.close()
						const wsManager = this.getResponsesWsManager()
						yield* processResponsesEvents(wsManager.createResponseEvents(fallbackParams), model.info)
						return
					}
					throw error
				}
			} catch (error) {
				Logger.error("OpenAI websocket mode failed, falling back to HTTP Responses API:", error)
				this.responsesWsManager?.close()
			}
		}

		// Try HTTP request
		try {
			yield* this.createResponseStreamHttp(params, model.info)
		} catch (error) {
			if (shouldRetryWithFullContext(error, !!params.previous_response_id)) {
				Logger.log("Retrying HTTP response with full context after previous_response_not_found or 404")
				yield* this.createResponseStreamHttp(fallbackParams, model.info)
				return
			}
			throw error
		}
	}

	private async *createResponseStreamHttp(
		params: OpenAI.Responses.ResponseCreateParamsStreaming,
		modelInfo: ModelInfo,
	): ApiStream {
		const client = this.ensureClient()
		const stream = await client.responses.create(params, { signal: this.abortController?.signal })
		yield* processResponsesEvents(stream, modelInfo)
	}

	abort(): void {
		this.responsesWsManager?.close()
		// Removed unused closeResponsesWebsocket call
		this.abortController?.abort()
		this.abortController = undefined
	}

	getModel(): { id: OpenAiNativeModelId; info: OpenAiCompatibleModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in openAiNativeModels) {
			const id = modelId as OpenAiNativeModelId
			const info = openAiNativeModels[id]
			return { id, info: { ...info } }
		}
		return {
			id: openAiNativeDefaultModelId,
			info: { ...openAiNativeModels[openAiNativeDefaultModelId] },
		}
	}
}
