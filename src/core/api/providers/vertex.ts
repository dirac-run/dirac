import type { MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import {
	ANTHROPIC_BETAS,
	CLAUDE_SONNET_1M_SUFFIX,
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
import { ApiStream } from "../transform/stream"
import { GeminiHandler } from "./gemini"

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

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		const model = this.getModel()
		const rawModelId = model.id
		const modelId = rawModelId.endsWith(CLAUDE_SONNET_1M_SUFFIX)
			? rawModelId.slice(0, -CLAUDE_SONNET_1M_SUFFIX.length)
			: rawModelId
		const enable1mContextWindow = rawModelId.endsWith(CLAUDE_SONNET_1M_SUFFIX)

		// For Gemini models, use the GeminiHandler
		if (!rawModelId.includes("claude")) {
			const geminiHandler = this.ensureGeminiHandler()
			yield* geminiHandler.createMessage(systemPrompt, messages, tools as GoogleTool[])
			return
		}

		const clientAnthropic = this.ensureAnthropicClient()

		// Claude implementation
		const budget_tokens = this.options.thinkingBudgetTokens || 0
		// Use model metadata to determine if reasoning should be enabled
		const reasoningOn = (model.info.supportsReasoning ?? false) && budget_tokens !== 0
		const useAdaptive = isAnthropicAdaptiveThinkingSupported(modelId, model.info)

		// Tools are available only when native tools are enabled.
		const nativeToolsOn = (tools?.length ?? 0) > 0

		const anthropicMessages = sanitizeAnthropicMessages(messages, model.info.supportsPromptCache ?? false)

		const stream = await clientAnthropic.beta.messages.create(
			{
				model: modelId,
				max_tokens: model.info.maxTokens || 8192,
				thinking: reasoningOn
					? useAdaptive
						? { type: "adaptive", display: "summarized" }
						: { type: "enabled", budget_tokens: budget_tokens }
					: undefined,
				...(reasoningOn && useAdaptive
					? { output_config: { effort: (this.options.reasoningEffort as AnthropicEffort) || "high" } }
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
				tool_choice: nativeToolsOn && !reasoningOn ? { type: "any" } : undefined,
			} as BetaMessageCreateParamsStreaming,
			enable1mContextWindow
				? {
						headers: {
							"anthropic-beta": ANTHROPIC_BETAS.CONTEXT_1M,
						},
					}
				: undefined,
		)

		const lastStartedToolCall = { id: "", name: "", arguments: "" }

		for await (const chunk of stream) {
			yield* this.parseVertexChunk(chunk, lastStartedToolCall)
		}
	}

	// Parses a single Anthropic stream chunk into Dirac ApiStreamChunk(s).
	private *parseVertexChunk(chunk: any, lastStartedToolCall: { id: string; name: string; arguments: string }): Generator<any> {
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
