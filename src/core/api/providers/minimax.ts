import { Anthropic } from "@anthropic-ai/sdk"
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { Stream as AnthropicStream } from "@anthropic-ai/sdk/streaming"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { MinimaxModelId, ModelInfo, minimaxDefaultModelId, minimaxModels } from "@/shared/api"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { DiracTool } from "@/shared/tools"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { ApiStream } from "../transform/stream"

interface MinimaxHandlerOptions extends CommonApiHandlerOptions {
	minimaxApiKey?: string
	minimaxApiLine?: string
	apiModelId?: string
	thinkingBudgetTokens?: number
}

export class MinimaxHandler implements ApiHandler {
	private options: MinimaxHandlerOptions
	private client: Anthropic | undefined

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

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		// Tools are available only when native tools are enabled
		const nativeToolsOn = (tools?.length ?? 0) > 0

		const budget_tokens = this.options.thinkingBudgetTokens || 0
		const reasoningOn = (model.info.supportsReasoning ?? false) && budget_tokens !== 0

		// MiniMax M2 uses Anthropic API format
		const stream: AnthropicStream<Anthropic.RawMessageStreamEvent> = await client.messages.create({
			model: model.id,
			max_tokens: model.info.maxTokens || 8192,
			system: [{ text: systemPrompt, type: "text" }],
			messages,
			stream: true,
			tools: nativeToolsOn ? (tools as AnthropicTool[]) : undefined,
			thinking: reasoningOn ? { type: "enabled", budget_tokens: budget_tokens } : undefined,
			// "Thinking isn't compatible with temperature, top_p, or top_k modifications"
			temperature: reasoningOn ? undefined : 1.0, // MiniMax recommends 1.0, range is (0.0, 1.0]
			// NOTE: Forcing tool use when tools are provided will result in error when thinking is also enabled.
			tool_choice: nativeToolsOn && !reasoningOn ? { type: "any" } : undefined,
		})

		const lastStartedToolCall = { id: "", name: "", arguments: "" }

		for await (const chunk of stream) {
			yield* handleStreamChunk(chunk, lastStartedToolCall)
		}
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
async function* handleStreamChunk(chunk: Anthropic.RawMessageStreamEvent, state: ToolCallState): ApiStream {
	switch (chunk.type) {
		case "message_start":
			return yield* handleMessageStart(chunk)
		case "message_delta":
			return yield* handleMessageDelta(chunk)
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

async function* handleMessageStart(chunk: Anthropic.RawMessageStartEvent): ApiStream {
	const usage = chunk.message.usage
	yield {
		type: "usage",
		inputTokens: usage.input_tokens || 0,
		outputTokens: usage.output_tokens || 0,
		cacheWriteTokens: usage.cache_creation_input_tokens || undefined,
		cacheReadTokens: usage.cache_read_input_tokens || undefined,
	}
}

async function* handleMessageDelta(chunk: Anthropic.RawMessageDeltaEvent): ApiStream {
	yield { type: "usage", inputTokens: chunk.usage.input_tokens || 0, outputTokens: chunk.usage.output_tokens || 0 }
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
