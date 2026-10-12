import {
	ModelInfo,
	type OpenAiNativeModelId,
	type OpenAiNativeModelInfo,
	openAiNativeDefaultModelId,
	openAiNativeModels,
} from "@shared/api"
import { resolveReasoningEffortForModel } from "@shared/utils/reasoning-support"
import OpenAI from "openai"
import type { ChatCompletionReasoningEffort, ChatCompletionTool } from "openai/resources/chat/completions"
import { featureFlagsService } from "@/services/feature-flags"
import { getErrorMessage } from "@/shared/errors"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
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
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { formatOpenAiCompatibleUsage } from "../transform/openai-usage"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor, type WebSearchChatTool } from "../transform/tool-call-processor"
import {
	buildResponseCreateParams,
	getOpenAIServiceTier,
	mapResponseTools,
	normalizeOpenAIServiceTier,
	processResponsesEvents,
	ResponsesWebsocketManager,
	shouldRetryWithFullContext,
} from "./openai-responses-utils"

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

	private isCurrentModelResponse(message: DiracStorageMessage, modelId: OpenAiNativeModelId): boolean {
		return (
			message.id?.startsWith("resp_") === true &&
			message.modelInfo?.providerId === "openai-native" &&
			message.modelInfo.modelId === modelId
		)
	}
	constructor(options: OpenAiNativeHandlerOptions) {
		this.options = options
	}

	private shouldEnableParallelToolCalling(): boolean {
		return isParallelToolCallingEnabled(this.options.enableParallelToolCalling ?? false)
	}

	private resolveServiceTier(modelInfo: ModelInfo) {
		const serviceTier = getOpenAIServiceTier(this.options.inferenceSpeed)
		if (serviceTier === "fast" && !modelInfo.supportsFastMode) {
			throw new Error("The selected OpenAI model does not support Fast mode")
		}
		return serviceTier
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
				throw new Error(`Error creating OpenAI client: ${getErrorMessage(error)}`)
			}
		}
		return this.client
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		if (!usage) return
		yield formatOpenAiCompatibleUsage(usage, info)
	}

	async compactConversation(request: ApiConversationCompactionRequest): Promise<ApiConversationCompactionResult> {
		const model = this.getModel()
		const usePersistedReasoning = supportsOpenAiPersistedReasoning(model.id, model.info.supportsPersistedReasoning)
		const reasoningEffort = resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort)
		const apiFormat = model.info.apiFormat
		if (apiFormat !== ApiFormat.OPENAI_RESPONSES && apiFormat !== ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE) {
			throw new Error("OpenAI Native conversation compaction requires the Responses API")
		}

		const finalTools: (ChatCompletionTool | WebSearchChatTool)[] = [
			...((request.tools ?? []) as ChatCompletionTool[]),
			{ type: "web_search" },
		]
		const responseTools = mapResponseTools(finalTools, model.info.supportsStrictTools)
		// checkpoint.input is opaque provider state; here it is a previously-returned ResponseInput
		const input: OpenAI.Responses.ResponseInput = [
			...((request.checkpoint?.input ?? []) as OpenAI.Responses.ResponseInput),
			...convertToOpenAIResponsesInput(request.messages).input,
		]
		const fullParams = buildResponseCreateParams({
			modelId: model.id,
			systemPrompt: request.systemPrompt,
			input,
			tools: responseTools,
			reasoningEffort,
			reasoningContext: usePersistedReasoning ? "all_turns" : undefined,
			enableParallelToolCalling: this.shouldEnableParallelToolCalling(),
		})
		const { stream, store, previous_response_id, ...compactParams } = fullParams
		void stream
		void store
		void previous_response_id

		this.abortController = new AbortController()
		try {
			const data = await this.ensureClient().responses.compact(compactParams as OpenAI.Responses.ResponseCompactParams, {
				signal: this.abortController.signal,
			})
			const output = data.output
			if (!Array.isArray(output)) throw new Error("OpenAI compact response did not contain replacement input items")
			const opaqueItem = output.find((item) => item.type === "compaction")
			if (!opaqueItem || typeof opaqueItem.encrypted_content !== "string") {
				throw new Error("OpenAI compact response did not contain opaque compaction state")
			}
			this.responsesWsManager?.close()
			return { input: output }
		} finally {
			this.abortController = undefined
		}
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools?: ChatCompletionTool[],
		options?: ApiConversationRequestOptions,
	): ApiStream {
		const finalTools: (ChatCompletionTool | WebSearchChatTool)[] = [...(tools || [])]
		finalTools.push({ type: "web_search" })
		const apiFormat = this.getModel()?.info?.apiFormat
		if (apiFormat === ApiFormat.OPENAI_RESPONSES || apiFormat === ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE) {
			if (!tools?.length) {
				throw new Error("Native Tool Call must be enabled in your setting for OpenAI Responses API")
			}
			yield* this.createResponseStream(systemPrompt, messages, finalTools, options)
			return
		}
		yield* this.createCompletionStream(systemPrompt, messages, finalTools)
	}

	private async *createCompletionStream(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools?: (ChatCompletionTool | WebSearchChatTool)[],
	): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const serviceTier = this.resolveServiceTier(model.info)
		const toolCallProcessor = new ToolCallProcessor()
		this.abortController = new AbortController()

		// Handle o1 models separately as they don't support streaming
		if (model.info.supportsStreaming === false) {
			const response = await client.chat.completions.create(
				{
					model: model.id,
					messages: [{ role: "user", content: systemPrompt }, ...convertToOpenAiMessages(messages, "openai-native")],
					...(serviceTier ? { service_tier: serviceTier } : {}),
				},
				{ signal: this.abortController?.signal },
			)
			yield {
				type: "text",
				text: response.choices[0]?.message.content || "",
			}
			yield formatOpenAiCompatibleUsage(response.usage || {}, model.info, {
				inferenceSpeed: normalizeOpenAIServiceTier(response.service_tier),
			})
			return
		}

		const systemRole = model.info.systemRole ?? "system"
		const includeReasoning = model.info.supportsReasoningEffort
		const includeTools = model.info.supportsTools ?? true
		const requestedEffort = resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort)
		const reasoningEffort =
			includeReasoning && requestedEffort && requestedEffort !== "none"
				? (requestedEffort as ChatCompletionReasoningEffort)
				: undefined

		const stream = await client.chat.completions.create(
			{
				model: model.id,
				messages: [{ role: systemRole, content: systemPrompt }, ...convertToOpenAiMessages(messages, "openai-native")],
				stream: true,
				stream_options: { include_usage: true },
				reasoning_effort: reasoningEffort,
				...(serviceTier ? { service_tier: serviceTier } : {}),
				...(model.info.temperature !== undefined ? { temperature: model.info.temperature } : {}),
				...(includeTools ? getOpenAIToolParams(tools, this.shouldEnableParallelToolCalling()) : {}),
			},
			{ signal: this.abortController.signal },
		)

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (chunk.usage) {
				// Only last chunk contains usage
				yield formatOpenAiCompatibleUsage(chunk.usage, model.info, {
					inferenceSpeed: normalizeOpenAIServiceTier(chunk.service_tier),
				})
			}
		}
	}

	private async *createResponseStream(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools: (ChatCompletionTool | WebSearchChatTool)[],
		options?: ApiConversationRequestOptions,
	): ApiStream {
		const model = this.getModel()
		const serviceTier = this.resolveServiceTier(model.info)
		const reasoningEffort = resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort)
		const usePersistedReasoning = supportsOpenAiPersistedReasoning(model.id, model.info.supportsPersistedReasoning)
		const useWebsocket = this.useWebsocketMode(model.info.apiFormat) && !usePersistedReasoning
		const usePreviousResponseId = !options?.breakProviderContinuation && (usePersistedReasoning || useWebsocket)

		if (options?.breakProviderContinuation) this.responsesWsManager?.close()
		if (useWebsocket) {
			this.getResponsesWsManager()
				.ensureWebsocket()
				.catch((error) => Logger.debug("OpenAI websocket preconnect failed:", error))
		}

		const converted = convertToOpenAIResponsesInput(messages, {
			usePreviousResponseId,
			canUsePreviousResponse: usePersistedReasoning
				? (message) => this.isCurrentModelResponse(message, model.id)
				: undefined,
		})
		// checkpoint.input is opaque provider state; here it is a previously-returned ResponseInput
		const fullInput: OpenAI.Responses.ResponseInput = [
			...((options?.checkpoint?.input ?? []) as OpenAI.Responses.ResponseInput),
			...convertToOpenAIResponsesInput(messages).input,
		]
		const input = converted.previousResponseId ? converted.input : fullInput
		const fallbackInput = fullInput
		const responseTools = mapResponseTools(tools, model.info.supportsStrictTools)
		this.abortController = new AbortController()

		const params = buildResponseCreateParams({
			modelId: model.id,
			systemPrompt,
			input,
			previousResponseId: converted.previousResponseId,
			tools: responseTools,
			reasoningEffort,
			reasoningContext: usePersistedReasoning ? "all_turns" : undefined,
			store: usePersistedReasoning ? true : undefined,
			enableParallelToolCalling: this.shouldEnableParallelToolCalling(),
			serviceTier,
		})
		const fallbackParams = buildResponseCreateParams({
			modelId: model.id,
			systemPrompt,
			input: fallbackInput,
			tools: responseTools,
			reasoningEffort,
			reasoningContext: usePersistedReasoning ? "all_turns" : undefined,
			store: usePersistedReasoning ? true : undefined,
			enableParallelToolCalling: this.shouldEnableParallelToolCalling(),
			serviceTier,
		})

		if (usePersistedReasoning) {
			const functionCallOutputs = input.filter((item) => item.type === "function_call_output").length
			Logger.log(
				`[OpenAI Native persisted reasoning] request=${converted.previousResponseId ? "continuation" : "full_context"} input_items=${input.length} function_call_outputs=${functionCallOutputs}`,
			)
		}

		if (useWebsocket && converted.previousResponseId) {
			let didEmitWebsocketOutput = false
			try {
				try {
					const wsManager = this.getResponsesWsManager()
					for await (const chunk of processResponsesEvents(wsManager.createResponseEvents(params), model.info)) {
						didEmitWebsocketOutput = true
						yield chunk
					}
					return
				} catch (error) {
					if (!didEmitWebsocketOutput && shouldRetryWithFullContext(error, !!params.previous_response_id)) {
						Logger.log("Retrying websocket response with full context after previous_response_not_found or 404")
						this.responsesWsManager?.close()
						const wsManager = this.getResponsesWsManager()
						for await (const chunk of processResponsesEvents(
							wsManager.createResponseEvents(fallbackParams),
							model.info,
						)) {
							didEmitWebsocketOutput = true
							yield chunk
						}
						return
					}
					throw error
				}
			} catch (error) {
				if (didEmitWebsocketOutput) throw error
				Logger.error("OpenAI websocket mode failed, falling back to HTTP Responses API:", error)
				this.responsesWsManager?.close()
			}
		}

		let didEmitHttpOutput = false
		try {
			for await (const chunk of this.createResponseStreamHttp(params, model.info)) {
				didEmitHttpOutput = true
				yield chunk
			}
		} catch (error) {
			if (!didEmitHttpOutput && shouldRetryWithFullContext(error, !!params.previous_response_id)) {
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
		this.abortController?.abort()
		this.abortController = undefined
	}

	getModel(): { id: OpenAiNativeModelId; info: OpenAiNativeModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in openAiNativeModels) {
			const id = modelId as OpenAiNativeModelId
			const info = openAiNativeModels[id]
			return { id, info: { ...info, supportsStrictTools: true } }
		}
		return {
			id: openAiNativeDefaultModelId,
			info: { ...openAiNativeModels[openAiNativeDefaultModelId], supportsStrictTools: true },
		}
	}
}
