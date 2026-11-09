import { Anthropic } from "@anthropic-ai/sdk"
import type {
	MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming,
	BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { MessageCreateParamsStreaming as AnthropicMessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import {
	AnthropicModelId,
	anthropicDefaultModelId,
	anthropicModels,
	getAnthropicReasoningEffort,
	getAnthropicThinkingConfig,
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
import { AnthropicThinkingRecovery } from "../transform/anthropic-thinking-recovery"
import { ApiStream, type ApiStreamUsageChunk } from "../transform/stream"

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
	private readonly thinkingRecovery = new AnthropicThinkingRecovery()

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
			} catch (error: any) {
				throw new Error(`Error creating Anthropic client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: AnthropicTool[]): ApiStream {
		const client = this.ensureClient()
		this.deliveredInferenceSpeed = undefined
		const model = this.getModel()
		const useFastMode = this.shouldUseFastMode(model.info)
		const createFastModeMessage = (
			body: AnthropicMessageCreateParamsStreaming,
		): Promise<AsyncIterable<BetaRawMessageStreamEvent>> => {
			return (
				client.beta.messages.create as unknown as (
					params: BetaMessageCreateParamsStreaming & { speed: "fast" },
				) => Promise<AsyncIterable<BetaRawMessageStreamEvent>>
			)({ ...body, betas: [ANTHROPIC_FAST_MODE_BETA], speed: "fast" })
		}

		const nativeToolsOn = (tools?.length ?? 0) > 0
		const thinking = getAnthropicThinkingConfig(model.id, model.info, this.options.thinkingBudgetTokens, this.options.reasoningEffort)
		const reasoningOn = thinking !== undefined && thinking.type !== "disabled"
		const useEffort = model.info.supportsReasoningEffort || thinking?.type === "adaptive"
		const requestBody: AnthropicMessageCreateParamsStreaming = {
			model: model.id,
			// The installed SDK predates Sonnet 5.5's between_tools mode.
			thinking: thinking as AnthropicMessageCreateParamsStreaming["thinking"],
			...(useEffort ? {
				output_config: { effort: getAnthropicReasoningEffort(model.info, this.options.reasoningEffort) as AnthropicEffort },
			} : {}),
			max_tokens: model.info.maxTokens || 8192,
			temperature: reasoningOn || model.info.supportsReasoningEffort ? undefined : model.info.temperature,
			system: [{
				text: systemPrompt,
				type: "text",
				...(model.info.supportsPromptCache ? { cache_control: { type: "ephemeral" as const } } : {}),
			}],
			messages: this.thinkingRecovery.prepareAnthropicMessages(sanitizeAnthropicMessages(messages, model.info.supportsPromptCache)),
			stream: true,
			tools: nativeToolsOn ? tools : undefined,
			tool_choice: model.info.supportsPromptCache
				? nativeToolsOn && !reasoningOn && model.info.supportsForcedToolUse !== false ? { type: "any" } : undefined
				: { type: "auto" },
		}

		for (let attempt = 0; attempt < 2; attempt++) {
			let didYield = false
			try {
				const stream = useFastMode ? await createFastModeMessage(requestBody) : await client.messages.create(requestBody)
				const lastStartedToolCall = { id: "", name: "", arguments: "" }
				const usage: ApiStreamUsageChunk = { type: "usage", inputTokens: 0, outputTokens: 0 }
				for await (const chunk of stream) {
					for (const parsed of this.parseAnthropicChunk(chunk, lastStartedToolCall, usage)) {
						didYield = true
						yield parsed
					}
				}
				return
			} catch (error) {
				if (attempt !== 0 || didYield) throw error
				requestBody.messages = this.thinkingRecovery.recoverAnthropicMessages(error, requestBody.messages)
			}
		}
	}

	private *parseAnthropicChunk(
		chunk: any,
		lastStartedToolCall: { id: string; name: string; arguments: string },
		usage: ApiStreamUsageChunk,
	): Generator<any> {
		switch (chunk?.type) {
			case "message_start":
				Object.assign(usage, this.parseAnthropicMessageStart(chunk))
				yield { ...usage }
				break
			case "message_delta":
				usage.outputTokens = chunk.usage.output_tokens ?? usage.outputTokens
				yield {
					...usage,
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
		const inferenceSpeed = usage.speed === "fast" ? "fast" : usage.speed === "standard" ? "standard" : undefined
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
