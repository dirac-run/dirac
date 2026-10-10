import type {
	MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming,
	BetaRawContentBlockDeltaEvent,
	BetaRawContentBlockStartEvent,
	BetaRawMessageStartEvent,
	BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import {
	getAnthropicReasoningEffort,
	isAnthropicAdaptiveThinkingSupported,
	ModelInfo,
	VertexModelId,
	vertexDefaultModelId,
	vertexModels,
} from "@shared/api"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { DiracTool } from "@/shared/tools"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { ApiStream, ApiStreamChunk, ApiStreamUsageChunk } from "../transform/stream"
import { GeminiHandler } from "./gemini"

// The installed SDK types do not yet include xhigh, which the API accepts for Opus 5.5.
type AnthropicEffort = "low" | "medium" | "high" | "max"

interface VertexHandlerOptions extends CommonApiHandlerOptions {
	vertexProjectId?: string
	vertexRegion?: string
	apiModelId?: string
	thinkingBudgetTokens?: number
	geminiApiKey?: string
	geminiBaseUrl?: string
	ulid?: string
	reasoningEffort?: string
}

export class VertexHandler implements ApiHandler {
	private geminiHandler: GeminiHandler | undefined
	private clientAnthropic: AnthropicVertex | undefined
	private options: VertexHandlerOptions
	private abortController: AbortController | undefined

	constructor(options: VertexHandlerOptions) {
		this.options = options
	}

	private ensureGeminiHandler(): GeminiHandler {
		if (!this.geminiHandler) {
			try {
				// Create a GeminiHandler with isVertex flag for Gemini models
				this.geminiHandler = new GeminiHandler({
					...this.options,
					isVertex: true,
				})
			} catch (error) {
				throw new Error(
					`Error creating Vertex AI Gemini handler: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
		return this.geminiHandler
	}

	private ensureAnthropicClient(): AnthropicVertex {
		if (!this.clientAnthropic) {
			if (!this.options.vertexProjectId) {
				throw new Error(
					"Vertex AI project ID is required. Please configure it in settings or set the GOOGLE_CLOUD_PROJECT environment variable.",
				)
			}
			if (!this.options.vertexRegion) {
				throw new Error(
					"Vertex AI region is required. Please configure it in settings or set the GOOGLE_CLOUD_LOCATION environment variable.",
				)
			}
			try {
				const externalHeaders = buildExternalBasicHeaders()
				// Initialize Anthropic client for Claude models
				this.clientAnthropic = new AnthropicVertex({
					projectId: this.options.vertexProjectId,
					// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude#regions
					region: this.options.vertexRegion,
					defaultHeaders: externalHeaders,
				})
			} catch (error) {
				throw new Error(
					`Error creating Vertex AI Anthropic client: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
		return this.clientAnthropic
	}

	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		const abortController = new AbortController()
		this.abortController = abortController

		try {
			yield* this.createMessageWithSignal(systemPrompt, messages, tools, abortController.signal)
		} finally {
			if (this.abortController === abortController) this.abortController = undefined
		}
	}

	@withRetry()
	private async *createMessageWithSignal(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools: DiracTool[] | undefined,
		signal: AbortSignal,
	): ApiStream {
		signal.throwIfAborted()
		const model = this.getModel()
		const modelId = model.id

		// For Gemini models, use the GeminiHandler
		if (!modelId.includes("claude")) {
			const geminiHandler = this.ensureGeminiHandler()
			yield* geminiHandler.createMessage(systemPrompt, messages, tools as GoogleTool[])
			return
		}

		const clientAnthropic = this.ensureAnthropicClient()

		// Claude implementation
		const budget_tokens = this.options.thinkingBudgetTokens || 0
		// Use model metadata to determine if reasoning should be enabled
		const reasoningOn = (model.info.supportsReasoning ?? false) && (model.info.thinkingAlwaysOn || budget_tokens !== 0)
		const useAdaptive = isAnthropicAdaptiveThinkingSupported(modelId, model.info)

		// Tools are available only when native tools are enabled.
		const nativeToolsOn = (tools?.length ?? 0) > 0

		const anthropicMessages = sanitizeAnthropicMessages(messages, model.info.supportsPromptCache ?? false)
		const request = {
			model: modelId,
			max_tokens: model.info.maxTokens || 8192,
			thinking: reasoningOn
				? useAdaptive
					? { type: "adaptive", display: "summarized" }
					: { type: "enabled", budget_tokens: budget_tokens }
				: undefined,
			...(reasoningOn && useAdaptive
				? {
						output_config: {
							effort: getAnthropicReasoningEffort(model.info, this.options.reasoningEffort) as AnthropicEffort,
						},
					}
				: {}),
			temperature: reasoningOn ? undefined : (model.info.temperature ?? undefined),
			system: [
				{
					text: systemPrompt,
					type: "text",
					cache_control: model.info.supportsPromptCache ? { type: "ephemeral" } : undefined,
				},
			],
			messages: anthropicMessages,
			stream: true,
			tools: nativeToolsOn ? (tools as AnthropicTool[]) : undefined,
			tool_choice:
				nativeToolsOn && !reasoningOn && model.info.supportsForcedToolUse !== false ? { type: "any" } : undefined,
		} as BetaMessageCreateParamsStreaming

		const stream = await clientAnthropic.beta.messages.create(request, { signal })

		const lastStartedToolCall = { id: "", name: "", arguments: "" }

		for await (const chunk of stream) {
			yield* this.parseVertexChunk(chunk, lastStartedToolCall)
		}
	}

	abort(): void {
		this.abortController?.abort()
		this.geminiHandler?.abort()
	}

	// Parses a single Anthropic stream chunk into Dirac ApiStreamChunk(s).
	private *parseVertexChunk(
		chunk: BetaRawMessageStreamEvent,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<ApiStreamChunk> {
		switch (chunk?.type) {
			case "message_start":
				yield this.parseVertexMessageStart(chunk)
				break
			case "message_delta":
				yield { type: "usage", inputTokens: 0, outputTokens: chunk.usage?.output_tokens || 0 }
				break
			case "content_block_start":
				yield* this.parseVertexContentBlockStart(chunk, lastStartedToolCall)
				break
			case "content_block_delta":
				yield* this.parseVertexContentBlockDelta(chunk, lastStartedToolCall)
				break
			case "content_block_stop":
				lastStartedToolCall.id = ""
				lastStartedToolCall.name = ""
				lastStartedToolCall.arguments = ""
				break
		}
	}

	private parseVertexMessageStart(chunk: BetaRawMessageStartEvent): ApiStreamUsageChunk {
		const usage = chunk.message.usage
		return {
			type: "usage",
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
			cacheReadTokens: usage.cache_read_input_tokens || undefined,
		}
	}

	private *parseVertexContentBlockStart(
		chunk: BetaRawContentBlockStartEvent,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<ApiStreamChunk> {
		switch (chunk.content_block.type) {
			case "thinking":
				yield { type: "reasoning", reasoning: chunk.content_block.thinking || "" }
				break
			case "redacted_thinking":
				yield { type: "reasoning", reasoning: "[Redacted thinking block]" }
				break
			case "tool_use":
				if (chunk.content_block.id && chunk.content_block.name) {
					lastStartedToolCall.id = chunk.content_block.id
					lastStartedToolCall.name = chunk.content_block.name
					lastStartedToolCall.arguments = ""
				}
				break
			case "text":
				if (chunk.index > 0) yield { type: "text", text: "\n" }
				yield { type: "text", text: chunk.content_block.text }
				break
		}
	}

	private *parseVertexContentBlockDelta(
		chunk: BetaRawContentBlockDeltaEvent,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<ApiStreamChunk> {
		switch (chunk.delta.type) {
			case "signature_delta":
				yield { type: "reasoning", reasoning: "", signature: chunk.delta.signature }
				break
			case "thinking_delta":
				yield { type: "reasoning", reasoning: chunk.delta.thinking }
				break
			case "input_json_delta":
				if (lastStartedToolCall.id && lastStartedToolCall.name && chunk.delta.partial_json) {
					yield {
						type: "tool_calls",
						tool_call: {
							...lastStartedToolCall,
							function: {
								id: lastStartedToolCall.id,
								name: lastStartedToolCall.name,
								arguments: chunk.delta.partial_json,
							},
						},
					}
				}
				break
			case "text_delta":
				yield { type: "text", text: chunk.delta.text }
				break
		}
	}

	getModel(): { id: VertexModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in vertexModels) {
			const id = modelId as VertexModelId
			return { id, info: vertexModels[id] }
		}
		return {
			id: vertexDefaultModelId,
			info: vertexModels[vertexDefaultModelId],
		}
	}
}
