import { Anthropic } from "@anthropic-ai/sdk"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import { Stream as AnthropicStream } from "@anthropic-ai/sdk/streaming"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { MinimaxModelId, ModelInfo, minimaxDefaultModelId, minimaxModels } from "@/shared/api"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { DiracTool } from "@/shared/tools"
import { resolveReasoningEffortForModel } from "@/shared/utils/reasoning-support"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { sanitizeAnthropicMessages } from "../transform/anthropic-format"
import { ApiStream, type ApiStreamUsageChunk } from "../transform/stream"

// MiniMax accepts xhigh; the Anthropic SDK's effort union does not yet include it.
type AnthropicEffort = NonNullable<MessageCreateParamsStreaming["output_config"]>["effort"]

interface MinimaxHandlerOptions extends CommonApiHandlerOptions {
	minimaxApiKey?: string
	minimaxApiLine?: string
	apiModelId?: string
	thinkingBudgetTokens?: number
	reasoningEffort?: string
}

export class MinimaxHandler implements ApiHandler {
	private options: MinimaxHandlerOptions
	private client: Anthropic | undefined
	private abortController: AbortController | undefined

	constructor(options: MinimaxHandlerOptions) {
		this.options = options
	}

	private ensureClient(): Anthropic {
		if (!this.client) {
			if (!this.options.minimaxApiKey) {
				throw new Error("MiniMax API key is required")
			}
			try {
				const externalHeaders = buildExternalBasicHeaders()
				this.client = new Anthropic({
					apiKey: this.options.minimaxApiKey,
					baseURL:
						this.options.minimaxApiLine === "china"
							? "https://api.minimaxi.com/anthropic"
							: "https://api.minimax.io/anthropic",
					defaultHeaders: externalHeaders,
					fetch, // Use configured fetch with proxy support
				})
			} catch (error) {
				throw new Error(`Error creating MiniMax client: ${error.message}`)
			}
		}
		return this.client
	}

	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		const abortController = new AbortController()
		this.abortController = abortController
		try {
			yield* this.createMessageWithRetry(systemPrompt, messages, tools, abortController.signal)
		} finally {
			if (this.abortController === abortController) this.abortController = undefined
		}
	}

	@withRetry()
	private async *createMessageWithRetry(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools: DiracTool[] | undefined,
		signal: AbortSignal,
	): ApiStream {
		signal.throwIfAborted()
		const client = this.ensureClient()
		const model = this.getModel()

		// Tools are available only when native tools are enabled
		const nativeToolsOn = (tools?.length ?? 0) > 0

		const budget_tokens = this.options.thinkingBudgetTokens || 0
		const reasoningOn = (model.info.supportsReasoning ?? false) && (model.info.thinkingAlwaysOn || budget_tokens !== 0)
		const reasoningEffort = resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort)

		// MiniMax uses the Anthropic API format with model-specific thinking controls.
		const stream: AnthropicStream<Anthropic.RawMessageStreamEvent> = await client.messages.create(
			{
				model: model.id,
				max_tokens: model.info.maxTokens || 8192,
				system: [{ text: systemPrompt, type: "text" }],
				messages: sanitizeAnthropicMessages(messages, false),
				stream: true,
				tools: nativeToolsOn ? (tools as AnthropicTool[]) : undefined,
				thinking: reasoningOn
					? model.info.supportsAdaptiveThinking
						? { type: "adaptive" }
						: { type: "enabled", budget_tokens }
					: undefined,
				output_config: reasoningOn && reasoningEffort ? { effort: reasoningEffort as AnthropicEffort } : undefined,
				// Fixed-budget thinking isn't compatible with sampling modifications.
				temperature: reasoningOn ? undefined : 1.0,
				tool_choice:
					nativeToolsOn && model.info.supportsForcedToolUse === false
						? { type: "auto" }
						: nativeToolsOn && !reasoningOn
							? { type: "any" }
							: undefined,
			},
			{ signal },
		)

		const lastStartedToolCall = { id: "", name: "", arguments: "" }
		const usage: ApiStreamUsageChunk = { type: "usage", inputTokens: 0, outputTokens: 0 }

		for await (const chunk of stream) {
			yield* handleStreamChunk(chunk, lastStartedToolCall, usage)
		}
	}

	abort(): void {
		this.abortController?.abort()
	}

	getModel(): { id: MinimaxModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in minimaxModels) {
			const id = modelId as MinimaxModelId
			return { id, info: minimaxModels[id] }
		}
		return { id: minimaxDefaultModelId, info: minimaxModels[minimaxDefaultModelId] }
	}
}

type ToolCallState = { id: string; name: string; arguments: string }

/** Dispatches a single Anthropic stream chunk to the appropriate handler. */
async function* handleStreamChunk(
	chunk: Anthropic.RawMessageStreamEvent,
	state: ToolCallState,
	usage: ApiStreamUsageChunk,
): ApiStream {
	switch (chunk.type) {
		case "message_start":
			return yield* handleMessageStart(chunk, usage)
		case "message_delta":
			return yield* handleMessageDelta(chunk, usage)
		case "message_stop":
			return
		case "content_block_start":
			return yield* handleContentBlockStart(chunk, state)
		case "content_block_delta":
			return yield* handleContentBlockDelta(chunk, state)
		case "content_block_stop":
			return resetToolCall(state)
	}
}

async function* handleMessageStart(chunk: Anthropic.RawMessageStartEvent, snapshot: ApiStreamUsageChunk): ApiStream {
	const usage = chunk.message.usage
	Object.assign(snapshot, {
		inputTokens: usage.input_tokens ?? 0,
		outputTokens: usage.output_tokens ?? 0,
		cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
		cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
	})
	yield { ...snapshot }
}

async function* handleMessageDelta(chunk: Anthropic.RawMessageDeltaEvent, snapshot: ApiStreamUsageChunk): ApiStream {
	const usage = chunk.usage
	snapshot.inputTokens = usage.input_tokens ?? snapshot.inputTokens
	snapshot.outputTokens = usage.output_tokens ?? snapshot.outputTokens
	if (usage.cache_creation_input_tokens != null) snapshot.cacheWriteTokens = usage.cache_creation_input_tokens
	if (usage.cache_read_input_tokens != null) snapshot.cacheReadTokens = usage.cache_read_input_tokens
	yield { ...snapshot }
}

async function* handleContentBlockStart(chunk: Anthropic.RawContentBlockStartEvent, state: ToolCallState): ApiStream {
	switch (chunk.content_block.type) {
		case "thinking":
			return yield {
				type: "reasoning",
				reasoning: chunk.content_block.thinking || "",
				signature: chunk.content_block.signature,
			}
		case "redacted_thinking":
			return yield { type: "reasoning", reasoning: "[Redacted thinking block]", redacted_data: chunk.content_block.data }
		case "tool_use":
			return handleToolUseStart(chunk, state)
		case "text":
			return yield* handleTextBlockStart(chunk)
	}
}

function handleToolUseStart(chunk: Anthropic.RawContentBlockStartEvent, state: ToolCallState): void {
	const block = chunk.content_block
	if (block.type !== "tool_use" || !block.id || !block.name) return
	state.id = block.id
	state.name = block.name
	state.arguments = ""
}

async function* handleTextBlockStart(chunk: Anthropic.RawContentBlockStartEvent): ApiStream {
	if (chunk.index > 0) yield { type: "text", text: "\n" }
	const block = chunk.content_block
	if (block.type === "text") yield { type: "text", text: block.text }
}

async function* handleContentBlockDelta(chunk: Anthropic.RawContentBlockDeltaEvent, state: ToolCallState): ApiStream {
	switch (chunk.delta.type) {
		case "thinking_delta":
			return yield { type: "reasoning", reasoning: chunk.delta.thinking }
		case "signature_delta":
			return yield* handleSignatureDelta(chunk)
		case "text_delta":
			return yield { type: "text", text: chunk.delta.text }
		case "input_json_delta":
			return yield* handleInputJsonDelta(chunk, state)
	}
}

async function* handleSignatureDelta(chunk: Anthropic.RawContentBlockDeltaEvent): ApiStream {
	const delta = chunk.delta
	if (delta.type !== "signature_delta" || !delta.signature) return
	yield { type: "reasoning", reasoning: "", signature: delta.signature }
}

async function* handleInputJsonDelta(chunk: Anthropic.RawContentBlockDeltaEvent, state: ToolCallState): ApiStream {
	const delta = chunk.delta
	if (delta.type !== "input_json_delta" || !state.id || !state.name || !delta.partial_json) return
	yield {
		type: "tool_calls",
		tool_call: {
			...state,
			function: { ...state, id: state.id, name: state.name, arguments: delta.partial_json },
		},
	}
}

function resetToolCall(state: ToolCallState): void {
	state.id = ""
	state.name = ""
	state.arguments = ""
}
