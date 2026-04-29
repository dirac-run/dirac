import { FirepassModelId, firepassDefaultModelId, firepassModels, ModelInfo } from "@shared/api"
import OpenAI from "openai"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { DiracTool } from "@/shared/tools"
import { ApiHandler, CommonApiHandlerOptions } from ".."
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { addReasoningContent } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

interface FirepassHandlerOptions extends CommonApiHandlerOptions {
	fireworksApiKey?: string
	firepassModelId?: string
	fireworksModelMaxCompletionTokens?: number
	fireworksModelMaxTokens?: number
}

export class FirepassHandler implements ApiHandler {
	private options: FirepassHandlerOptions
	private client: OpenAI | undefined

	constructor(options: FirepassHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.fireworksApiKey) {
				throw new Error("Fireworks API key is required (Firepass uses Fireworks API key)")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: "https://api.fireworks.ai/inference/v1",
					apiKey: this.options.fireworksApiKey,
				})
			} catch (error) {
				throw new Error(`Error creating Firepass client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		const client = this.ensureClient()
		const modelId = this.options.firepassModelId ?? ""

		const model = this.getModel()
		const convertedMessages = convertToOpenAiMessages(messages)
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...((model.info as any).isR1FormatRequired ? addReasoningContent(convertedMessages, messages) : convertedMessages),
		]
		const toolParams = getOpenAIToolParams(tools as any)

		const stream = await client.chat.completions.create({
			model: modelId,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			temperature: 0,
			...toolParams,
		})

		let reasoning: string | null = null
		const toolCallProcessor = new ToolCallProcessor()

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (reasoning || delta?.content?.includes("<thinking>")) {
				reasoning = (reasoning || "") + (delta.content ?? "")
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (delta?.content && !reasoning) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (reasoning || (delta && "reasoning_content" in delta && delta.reasoning_content)) {
				yield {
					type: "reasoning",
					reasoning: delta.content || ((delta as any).reasoning_content as string | undefined) || "",
				}
				if (reasoning?.includes("</thinking>")) {
					// Reset so the next chunk is regular content
					reasoning = null
				}
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
					// @ts-expect-error-next-line
					cacheReadTokens: chunk.usage.prompt_cache_hit_tokens || 0,
					// @ts-expect-error-next-line
					cacheWriteTokens: chunk.usage.prompt_cache_miss_tokens || 0,
				}
			}
		}
	}

	getModel(): { id: FirepassModelId; info: ModelInfo } {
		const modelId = this.options.firepassModelId
		if (modelId && modelId in firepassModels) {
			const id = modelId as FirepassModelId
			return { id, info: firepassModels[id] }
		}
		return {
			id: firepassDefaultModelId,
			info: firepassModels[firepassDefaultModelId],
		}
	}
}
