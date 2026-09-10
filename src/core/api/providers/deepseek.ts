import { DeepSeekModelId, deepSeekDefaultModelId, deepSeekModels, ModelInfo } from "@shared/api"
import { normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { formatOpenAiCompatibleUsage } from "../transform/openai-usage"
import { addReasoningContent } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

interface DeepSeekHandlerOptions extends CommonApiHandlerOptions {
	deepSeekApiKey?: string
	reasoningEffort?: string
	apiModelId?: string
}

export class DeepSeekHandler implements ApiHandler {
	private options: DeepSeekHandlerOptions
	private client: OpenAI | undefined
	private abortController: AbortController | undefined

	constructor(options: DeepSeekHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.deepSeekApiKey) {
				throw new Error("DeepSeek API key is required")
			}
			try {
				this.client = new OpenAI({
					baseURL: "https://api.deepseek.com/v1",
					apiKey: this.options.deepSeekApiKey,
					defaultHeaders: buildExternalBasicHeaders(),
					fetch, // Use configured fetch with proxy support
				})
			} catch (error) {
				throw new Error(`Error creating DeepSeek client: ${error.message}`)
			}
		}
		return this.client
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		if (!usage) return
		yield formatOpenAiCompatibleUsage(usage, info)
	}

	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: OpenAITool[]): ApiStream {
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
		tools: OpenAITool[] | undefined,
		signal: AbortSignal,
	): ApiStream {
		signal.throwIfAborted()
		const client = this.ensureClient()
		const model = this.getModel()

		const supportsReasoning = model.info.supportsReasoning
		const requestedEffort = normalizeOpenaiReasoningEffort(this.options.reasoningEffort)
		const isThinkingEnabled = supportsReasoning && requestedEffort !== "none"
		const useReasoningFormat = isThinkingEnabled

		const shouldAddReasoningContent = supportsReasoning

		const convertedMessages = convertToOpenAiMessages(messages, undefined, model.info.supportsImages !== false)
		const openAiMessages = shouldAddReasoningContent
			? [
				{ role: "system", content: systemPrompt },
				...addReasoningContent(convertedMessages, messages, {
					onlyIfToolCall: !tools?.length,
				}),
			]
			: [{ role: "system", content: systemPrompt }, ...convertedMessages]

		// DeepSeek.com API requires reasoning_content to be passed back for ALL assistant messages
		// and content to be at least an empty string (not null).
		const deepSeekMessages = openAiMessages.map((msg) => {
			if (msg.role === "assistant") {
				return {
					...msg,
					content: msg.content ?? "",
					reasoning_content: (msg as any).reasoning_content ?? "",
				}
			}
			return msg
		})

		const deepSeekTools = tools?.map((tool) => {
			if (tool.type === "function") {
				return {
					...tool,
					function: {
						...tool.function,
						strict: true,
					},
				}
			}
			return tool
		})

		const stream = await client.chat.completions.create(
			{
				model: model.id,
				max_tokens: model.info.maxTokens,
				messages: deepSeekMessages as any,
				stream: true,
				stream_options: { include_usage: true },
				...(supportsReasoning
					? {
						extra_body: {
							thinking: {
								type: isThinkingEnabled ? "enabled" : "disabled",
							},
						},
						...(isThinkingEnabled ? { reasoning_effort: requestedEffort } : {}),
					}
					: {}),
				...(useReasoningFormat ? {} : { temperature: 0 }),
				...getOpenAIToolParams(deepSeekTools),
			},
			{ signal },
		)

		const toolCallProcessor = new ToolCallProcessor()

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

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					reasoning: (delta.reasoning_content as string | undefined) || "",
				}
			}

			if (chunk.usage) {
				yield* this.yieldUsage(model.info, chunk.usage)
			}
		}
	}

	abort(): void {
		this.abortController?.abort()
	}

	getModel(): { id: DeepSeekModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in deepSeekModels) {
			const id = modelId as DeepSeekModelId
			return { id, info: deepSeekModels[id] }
		}
		return {
			id: deepSeekDefaultModelId,
			info: deepSeekModels[deepSeekDefaultModelId],
		}
	}
}
