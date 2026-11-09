import type { MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming, BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import {
	getAnthropicReasoningEffort,
	getAnthropicThinkingConfig,
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
import { AnthropicThinkingRecovery } from "../transform/anthropic-thinking-recovery"
import { ApiStream, type ApiStreamUsageChunk } from "../transform/stream"
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
	private readonly thinkingRecovery = new AnthropicThinkingRecovery()

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
			} catch (error: any) {
				throw new Error(`Error creating Vertex AI Gemini handler: ${error.message}`)
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
			} catch (error: any) {
				throw new Error(`Error creating Vertex AI Anthropic client: ${error.message}`)
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
		const thinking = getAnthropicThinkingConfig(
			modelId,
			model.info,
			this.options.thinkingBudgetTokens,
			this.options.reasoningEffort,
		)
		const reasoningOn = thinking !== undefined && thinking.type !== "disabled"
		const useEffort = model.info.supportsReasoningEffort || thinking?.type === "adaptive"

		// Tools are available only when native tools are enabled.
		const nativeToolsOn = (tools?.length ?? 0) > 0

		let anthropicMessages = this.thinkingRecovery.prepareAnthropicMessages(
			sanitizeAnthropicMessages(messages, model.info.supportsPromptCache),
		)
		const request = {
			model: modelId,
			max_tokens: model.info.maxTokens || 8192,
			thinking,
			...(useEffort
				? {
					output_config: {
						effort: getAnthropicReasoningEffort(model.info, this.options.reasoningEffort) as AnthropicEffort,
					},
				}
				: {}),
			temperature: reasoningOn || model.info.supportsReasoningEffort ? undefined : model.info.temperature,
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

		for (let attempt = 0; attempt < 2; attempt++) {
			let didYield = false
			try {
				const stream = await clientAnthropic.beta.messages.create({ ...request, messages: anthropicMessages }, { signal })
				const lastStartedToolCall = { id: "", name: "", arguments: "" }
				const usage: ApiStreamUsageChunk = { type: "usage", inputTokens: 0, outputTokens: 0 }
				for await (const chunk of stream) {
					for (const parsed of this.parseVertexChunk(chunk, lastStartedToolCall, usage)) {
						didYield = true
						yield parsed
					}
				}
				return
			} catch (error) {
				if (attempt !== 0 || didYield) throw error
				anthropicMessages = this.thinkingRecovery.recoverAnthropicMessages(error, anthropicMessages)
			}
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
		usage: ApiStreamUsageChunk,
	): Generator<any> {
		switch (chunk?.type) {
			case "message_start":
				Object.assign(usage, this.parseVertexMessageStart(chunk))
				yield { ...usage }
				break
			case "message_delta":
				usage.outputTokens = chunk.usage?.output_tokens ?? usage.outputTokens
				yield { ...usage }
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

	private parseVertexMessageStart(chunk: any): any {
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
		chunk: any,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<any> {
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
		chunk: any,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<any> {
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
