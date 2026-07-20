import { Anthropic } from "@anthropic-ai/sdk"
import type {
	MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming,
	BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { MessageCreateParamsStreaming as AnthropicMessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import { Stream as AnthropicStream } from "@anthropic-ai/sdk/streaming"
import {
	ANTHROPIC_BETAS,
	ANTHROPIC_FAST_MODE_SUFFIX,
	AnthropicModelId,
	anthropicDefaultModelId,
	anthropicModels,
	CLAUDE_SONNET_1M_SUFFIX,
	isAnthropicAdaptiveThinkingSupported,
	ModelInfo,
} from "@shared/api"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { ApiStream } from "../transform/stream"

export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01"

type AnthropicEffort = "low" | "medium" | "high" | "max"

interface AnthropicHandlerOptions extends CommonApiHandlerOptions {
	apiKey?: string
	anthropicBaseUrl?: string
	anthropicHeaders?: Record<string, string>
	apiModelId?: string
	thinkingBudgetTokens?: number
	reasoningEffort?: string
}

export class AnthropicHandler implements ApiHandler {
	private options: AnthropicHandlerOptions
	private client: Anthropic | undefined

	constructor(options: AnthropicHandlerOptions) {
		this.options = options
	}

	private ensureClient(): Anthropic {
		if (!this.client) {
			if (!this.options.apiKey) {
				throw new Error("Anthropic API key is required")
			}
			try {
				this.client = new Anthropic({
					apiKey: this.options.apiKey,
					baseURL: this.options.anthropicBaseUrl || undefined,
					defaultHeaders: {
						...buildExternalBasicHeaders(),
						...this.options.anthropicHeaders,
					},
					fetch, // Use configured fetch with proxy support
				})
			} catch (error) {
				throw new Error(`Error creating Anthropic client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: AnthropicTool[]): ApiStream {
		const client = this.ensureClient()

		const model = this.getModel()
		let stream: AnthropicStream<Anthropic.RawMessageStreamEvent> | AsyncIterable<BetaRawMessageStreamEvent>

		const useFastMode = model.id.endsWith(ANTHROPIC_FAST_MODE_SUFFIX)
		const baseModelId = useFastMode ? model.id.slice(0, -ANTHROPIC_FAST_MODE_SUFFIX.length) : model.id
		const modelId = baseModelId.endsWith(CLAUDE_SONNET_1M_SUFFIX)
			? baseModelId.slice(0, -CLAUDE_SONNET_1M_SUFFIX.length)
			: baseModelId
		const enable1mContextWindow = baseModelId.endsWith(CLAUDE_SONNET_1M_SUFFIX)
		const fastModeBetas = enable1mContextWindow
			? [ANTHROPIC_FAST_MODE_BETA, ANTHROPIC_BETAS.CONTEXT_1M]
			: [ANTHROPIC_FAST_MODE_BETA]
		const createFastModeMessage = (
			body: AnthropicMessageCreateParamsStreaming,
		): Promise<AsyncIterable<BetaRawMessageStreamEvent>> => {
			return (
				client.beta.messages.create as unknown as (
					params: BetaMessageCreateParamsStreaming & { speed: "fast" },
				) => Promise<AsyncIterable<BetaRawMessageStreamEvent>>
			)({
				...body,
				betas: fastModeBetas,
				speed: "fast",
			})
		}

		const budget_tokens = this.options.thinkingBudgetTokens || 0

		// Tools are available only when native tools are enabled.
		const nativeToolsOn = (tools?.length ?? 0) > 0
		const reasoningOn = (model.info.supportsReasoning ?? false) && budget_tokens !== 0
		const useAdaptive = isAnthropicAdaptiveThinkingSupported(modelId, model.info)

		if (model.info.supportsPromptCache) {
			const anthropicMessages = sanitizeAnthropicMessages(messages, true)
			const requestBody: AnthropicMessageCreateParamsStreaming = {
				model: modelId,
				thinking: reasoningOn
					? useAdaptive
						? { type: "adaptive", display: "summarized" }
						: { type: "enabled", budget_tokens: budget_tokens }
					: undefined,
				...(reasoningOn && useAdaptive
					? { output_config: { effort: (this.options.reasoningEffort as AnthropicEffort) || "high" } }
					: {}),
				max_tokens: model.info.maxTokens || 8192,
				// "Thinking isn’t compatible with temperature, top_p, or top_k modifications as well as forced tool use."
				// (https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#important-considerations-when-using-extended-thinking)
				temperature: reasoningOn ? undefined : (model.info.temperature ?? undefined),
				system: [
					{
						text: systemPrompt,
						type: "text",
						cache_control: { type: "ephemeral" },
					},
				], // setting cache breakpoint for system prompt so new tasks can reuse it
				messages: anthropicMessages,
				// tools, // cache breakpoints go from tools > system > messages, and since tools dont change, we can just set the breakpoint at the end of system (this avoids having to set a breakpoint at the end of tools which by itself does not meet min requirements for haiku caching)
				stream: true,
				tools: nativeToolsOn ? tools : undefined,
				// tool_choice options:
				// - none: disables tool use, even if tools are provided. Claude will not call any tools.
				// - auto: allows Claude to decide whether to call any provided tools or not. This is the default value when tools are provided.
				// - any: tells Claude that it must use one of the provided tools, but doesn’t force a particular tool.
				// NOTE: Forcing tool use when tools are provided will result in error when thinking is also enabled.
				tool_choice: nativeToolsOn && !reasoningOn ? { type: "any" } : undefined,
			}

			stream = useFastMode
				? await createFastModeMessage(requestBody)
				: await client.messages.create(
						requestBody,
						(() => {
							// 1m context window beta header
							if (enable1mContextWindow) {
								return {
									headers: {
										"anthropic-beta": ANTHROPIC_BETAS.CONTEXT_1M,
									},
								}
							}
							return undefined
						})(),
					)
		} else {
			const requestBody: AnthropicMessageCreateParamsStreaming = {
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
				system: [{ text: systemPrompt, type: "text" }],
				messages: sanitizeAnthropicMessages(messages, false),
				tools: nativeToolsOn ? tools : undefined,
				tool_choice: { type: "auto" },
				stream: true,
			}

			stream = useFastMode ? await createFastModeMessage(requestBody) : await client.messages.create(requestBody)
		}

		const lastStartedToolCall = { id: "", name: "", arguments: "" }

		for await (const chunk of stream) {
			yield* this.parseAnthropicChunk(chunk, lastStartedToolCall)
		}
	}

	// Parses a single Anthropic stream chunk into Dirac ApiStreamChunk(s).
	private *parseAnthropicChunk(
		chunk: any,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<any> {
		switch (chunk?.type) {
			case "message_start":
				yield this.parseAnthropicMessageStart(chunk)
				break
			case "message_delta":
				yield {
					type: "usage",
					inputTokens: 0,
					outputTokens: chunk.usage.output_tokens || 0,
					stopReason: chunk.delta.stop_reason || undefined,
				}
				break
			case "content_block_start":
				yield* this.parseAnthropicContentBlockStart(chunk, lastStartedToolCall)
				break
			case "content_block_delta":
				yield* this.parseAnthropicContentBlockDelta(chunk, lastStartedToolCall)
				break
			case "content_block_stop":
				lastStartedToolCall.id = ""
				lastStartedToolCall.name = ""
				lastStartedToolCall.arguments = ""
				break
		}
	}

	private parseAnthropicMessageStart(chunk: any): any {
		const usage = chunk.message.usage
		return {
			type: "usage",
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
			cacheReadTokens: usage.cache_read_input_tokens || undefined,
		}
	}

	private *parseAnthropicContentBlockStart(
		chunk: any,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<any> {
		switch (chunk.content_block.type) {
			case "thinking":
				yield {
					type: "reasoning",
					reasoning: chunk.content_block.thinking || "",
					signature: chunk.content_block.signature,
				}
				break
			case "redacted_thinking":
				yield { type: "reasoning", reasoning: "[Redacted thinking block]", redacted_data: chunk.content_block.data }
				break
			case "tool_use":
				if (chunk.content_block.id && chunk.content_block.name) {
					lastStartedToolCall.id = chunk.content_block.id
					lastStartedToolCall.name = chunk.content_block.name
					lastStartedToolCall.arguments = ""
					yield {
						type: "tool_calls",
						tool_call: {
							call_id: lastStartedToolCall.id,
							function: { id: lastStartedToolCall.id, name: lastStartedToolCall.name, arguments: "" },
						},
					}
				}
				break
			case "text":
				if (chunk.index > 0) yield { type: "text", text: "\n" }
				yield { type: "text", text: chunk.content_block.text }
				break
		}
	}

	private *parseAnthropicContentBlockDelta(
		chunk: any,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<any> {
		switch (chunk.delta.type) {
			case "thinking_delta":
				yield { type: "reasoning", reasoning: chunk.delta.thinking }
				break
			case "signature_delta":
				if (chunk.delta.signature) yield { type: "reasoning", reasoning: "", signature: chunk.delta.signature }
				break
			case "text_delta":
				yield { type: "text", text: chunk.delta.text }
				break
			case "input_json_delta":
				if (lastStartedToolCall.id && lastStartedToolCall.name && chunk.delta.partial_json !== undefined) {
					yield {
						type: "tool_calls",
						tool_call: {
							...lastStartedToolCall,
							function: {
								...lastStartedToolCall,
								id: lastStartedToolCall.id,
								name: lastStartedToolCall.name,
								arguments: chunk.delta.partial_json,
							},
						},
					}
				}
				break
		}
	}

	getModel(): { id: AnthropicModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in anthropicModels) {
			const id = modelId as AnthropicModelId
			return { id, info: anthropicModels[id] }
		}
		return {
			id: anthropicDefaultModelId,
			info: anthropicModels[anthropicDefaultModelId],
		}
	}
}
