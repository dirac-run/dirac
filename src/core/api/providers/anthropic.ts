import { Anthropic } from "@anthropic-ai/sdk"
import type {
	MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming,
	BetaRawContentBlockDeltaEvent,
	BetaRawContentBlockStartEvent,
	BetaRawMessageStartEvent,
	BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { MessageCreateParamsStreaming as AnthropicMessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import { Stream as AnthropicStream } from "@anthropic-ai/sdk/streaming"
import {
	AnthropicModelId,
	anthropicDefaultModelId,
	anthropicModels,
	getAnthropicReasoningEffort,
	isAnthropicAdaptiveThinkingSupported,
	ModelInfo,
} from "@shared/api"
import { type InferenceSpeed, normalizeInferenceSpeed } from "@shared/storage/types"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { getModelInfoForInferenceSpeed } from "@/utils/cost"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { ApiStream, ApiStreamChunk, ApiStreamUsageChunk } from "../transform/stream"

export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01"

// The installed SDK types do not yet include xhigh, which the API accepts for Opus 5.5.
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
	private deliveredInferenceSpeed: InferenceSpeed | undefined

	constructor(options: AnthropicHandlerOptions) {
		this.options = options
	}

	private shouldUseFastMode(modelInfo: ModelInfo): boolean {
		const useFastMode = normalizeInferenceSpeed(this.options.inferenceSpeed) === "fast"
		if (useFastMode && !modelInfo.supportsFastMode) {
			throw new Error("The selected Anthropic model does not support Fast mode")
		}
		return useFastMode
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
					fetch,
				})
			} catch (error) {
				throw new Error(`Error creating Anthropic client: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: AnthropicTool[]): ApiStream {
		const client = this.ensureClient()
		this.deliveredInferenceSpeed = undefined
		const model = this.getModel()
		let stream: AnthropicStream<Anthropic.RawMessageStreamEvent> | AsyncIterable<BetaRawMessageStreamEvent>

		const useFastMode = this.shouldUseFastMode(model.info)
		const createFastModeMessage = (
			body: AnthropicMessageCreateParamsStreaming,
		): Promise<AsyncIterable<BetaRawMessageStreamEvent>> => {
			return (
				client.beta.messages.create as unknown as (
					params: BetaMessageCreateParamsStreaming & { speed: "fast" },
				) => Promise<AsyncIterable<BetaRawMessageStreamEvent>>
			)({
				...body,
				betas: [ANTHROPIC_FAST_MODE_BETA],
				speed: "fast",
			})
		}

		const budget_tokens = this.options.thinkingBudgetTokens || 0
		const nativeToolsOn = (tools?.length ?? 0) > 0
		const reasoningOn = (model.info.supportsReasoning ?? false) && (model.info.thinkingAlwaysOn || budget_tokens !== 0)
		const useAdaptive = isAnthropicAdaptiveThinkingSupported(model.id, model.info)

		if (model.info.supportsPromptCache) {
			const anthropicMessages = sanitizeAnthropicMessages(messages, true)
			const requestBody: AnthropicMessageCreateParamsStreaming = {
				model: model.id,
				thinking: reasoningOn
					? useAdaptive
						? { type: "adaptive", display: "summarized" }
						: { type: "enabled", budget_tokens }
					: undefined,
				...(reasoningOn && useAdaptive
					? {
							output_config: {
								effort: getAnthropicReasoningEffort(model.info, this.options.reasoningEffort) as AnthropicEffort,
							},
						}
					: {}),
				max_tokens: model.info.maxTokens || 8192,
				temperature: reasoningOn ? undefined : (model.info.temperature ?? undefined),
				system: [
					{
						text: systemPrompt,
						type: "text",
						cache_control: { type: "ephemeral" },
					},
				],
				messages: anthropicMessages,
				stream: true,
				tools: nativeToolsOn ? tools : undefined,
				tool_choice:
					nativeToolsOn && !reasoningOn && model.info.supportsForcedToolUse !== false ? { type: "any" } : undefined,
			}

			stream = useFastMode ? await createFastModeMessage(requestBody) : await client.messages.create(requestBody)
		} else {
			const requestBody: AnthropicMessageCreateParamsStreaming = {
				model: model.id,
				max_tokens: model.info.maxTokens || 8192,
				thinking: reasoningOn
					? useAdaptive
						? { type: "adaptive", display: "summarized" }
						: { type: "enabled", budget_tokens }
					: undefined,
				...(reasoningOn && useAdaptive
					? {
							output_config: {
								effort: getAnthropicReasoningEffort(model.info, this.options.reasoningEffort) as AnthropicEffort,
							},
						}
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

	private *parseAnthropicChunk(
		chunk: Anthropic.RawMessageStreamEvent | BetaRawMessageStreamEvent,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<ApiStreamChunk> {
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

	private parseAnthropicMessageStart(chunk: Anthropic.RawMessageStartEvent | BetaRawMessageStartEvent): ApiStreamUsageChunk {
		const usage = chunk.message.usage
		// `speed` is only present on beta (fast-mode) usage payloads
		const speed = "speed" in usage ? usage.speed : undefined
		const inferenceSpeed = speed === "fast" ? "fast" : speed === "standard" ? "standard" : undefined
		this.deliveredInferenceSpeed = inferenceSpeed
		return {
			type: "usage",
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
			cacheReadTokens: usage.cache_read_input_tokens || undefined,
			...(inferenceSpeed ? { inferenceSpeed } : {}),
		}
	}

	private *parseAnthropicContentBlockStart(
		chunk: Anthropic.RawContentBlockStartEvent | BetaRawContentBlockStartEvent,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<ApiStreamChunk> {
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
		chunk: Anthropic.RawContentBlockDeltaEvent | BetaRawContentBlockDeltaEvent,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<ApiStreamChunk> {
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
		const inferenceSpeed = this.deliveredInferenceSpeed ?? normalizeInferenceSpeed(this.options.inferenceSpeed)
		const modelId = this.options.apiModelId
		if (modelId && modelId in anthropicModels) {
			const id = modelId as AnthropicModelId
			return {
				id,
				info: getModelInfoForInferenceSpeed(anthropicModels[id], inferenceSpeed),
			}
		}
		return {
			id: anthropicDefaultModelId,
			info: getModelInfoForInferenceSpeed(anthropicModels[anthropicDefaultModelId], inferenceSpeed),
		}
	}
}
