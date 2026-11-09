import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { ModelInfo, MoonshotModelId, moonshotDefaultModelId, moonshotModels } from "@/shared/api"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { resolveReasoningEffortForModel } from "@/shared/utils/reasoning-support"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { addReasoningContent } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

// K3-family APIs support a larger ceiling, but default to this completion budget.
const MOONSHOT_DEFAULT_MAX_COMPLETION_TOKENS = 131_072

interface MoonshotHandlerOptions extends CommonApiHandlerOptions {
	moonshotApiKey?: string
	moonshotApiLine?: string
	apiModelId?: string
	reasoningEffort?: string
}

// Enhanced usage interface to support Moonshot's cached token field
interface MoonshotUsage extends OpenAI.CompletionUsage {
	cached_tokens?: number
	prompt_tokens_details?: OpenAI.CompletionUsage.PromptTokensDetails & {
		cache_write_tokens?: number
	}
}

export class MoonshotHandler implements ApiHandler {
	private client: OpenAI | undefined
	private abortController: AbortController | undefined

	constructor(private readonly options: MoonshotHandlerOptions) {}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.moonshotApiKey) {
				throw new Error("Moonshot API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL:
						this.options.moonshotApiLine === "china" ? "https://api.moonshot.cn/v1" : "https://api.moonshot.ai/v1",
					apiKey: this.options.moonshotApiKey,
				})
			} catch (error) {
				throw new Error(`Error creating Moonshot client: ${error.message}`)
			}
		}
		return this.client
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

		const convertedMessages = convertToOpenAiMessages(messages, undefined, model.info.supportsImages !== false)
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...((model.info as any).isR1FormatRequired ? addReasoningContent(convertedMessages, messages) : convertedMessages),
		]

		const request = {
			model: model.id,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			...getOpenAIToolParams(tools),
			...(model.info.supportsReasoningEffort
				? {
						max_completion_tokens: MOONSHOT_DEFAULT_MAX_COMPLETION_TOKENS,
						reasoning_effort: resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort),
					}
				: { max_tokens: model.info.maxTokens, temperature: model.info.temperature }),
		}
		const stream = await client.chat.completions.create(request as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
			signal,
		})

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
				const usage = chunk.usage as MoonshotUsage
				const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0
				// Keep writes at the input rate for legacy models without separate write pricing.
				const cacheWriteTokens =
					model.info.cacheWritesPrice === undefined ? 0 : (usage.prompt_tokens_details?.cache_write_tokens ?? 0)
				yield {
					type: "usage",
					cacheWriteTokens,
					cacheReadTokens,
					inputTokens: (usage.prompt_tokens ?? 0) - cacheReadTokens - cacheWriteTokens,
					outputTokens: usage.completion_tokens ?? 0,
				}
			}
		}
	}

	abort(): void {
		this.abortController?.abort()
	}

	getModel(): { id: MoonshotModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId

		if (modelId && modelId in moonshotModels) {
			const id = modelId as MoonshotModelId
			return { id, info: moonshotModels[id] }
		}
		return { id: moonshotDefaultModelId, info: moonshotModels[moonshotDefaultModelId] }
	}
}
