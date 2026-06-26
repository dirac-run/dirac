import Cerebras from "@cerebras/cerebras_cloud_sdk"
import type { ChatCompletion, ChatCompletionCreateParamsStreaming } from "@cerebras/cerebras_cloud_sdk/resources/chat/completions"

type CerebrasChunk = ChatCompletion.ChatChunkResponse

import { CerebrasModelId, cerebrasDefaultModelId, cerebrasModels, ModelInfo } from "@shared/api"
import { isRateLimited, isServerError } from "@shared/net"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { DiracTool } from "@/shared/tools"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

interface CerebrasHandlerOptions extends CommonApiHandlerOptions {
	cerebrasApiKey?: string
	apiModelId?: string
}

// Conservative max_tokens for Cerebras to avoid premature rate limiting.
// Cerebras rate limiter estimates token consumption using max_completion_tokens upfront,
// so requesting the model maximum (e.g., 64K) reserves that quota even if actual usage is low.
// 16K is sufficient for most agentic tool use while preserving rate limit headroom.
const CEREBRAS_DEFAULT_MAX_TOKENS = 16_384

export class CerebrasHandler implements ApiHandler {
	private options: CerebrasHandlerOptions
	private client: Cerebras | undefined

	constructor(options: CerebrasHandlerOptions) {
		this.options = options
	}

	private ensureClient(): Cerebras {
		if (!this.client) {
			// Clean and validate the API key
			const cleanApiKey = this.options.cerebrasApiKey?.trim()

			if (!cleanApiKey) {
				throw new Error("Cerebras API key is required")
			}

			try {
				const externalHeaders = buildExternalBasicHeaders()
				this.client = new Cerebras({
					apiKey: cleanApiKey,
					timeout: 30000, // 30 second timeout
					fetch, // Use configured fetch with proxy support
					defaultHeaders: {
						...externalHeaders,
						"X-Cerebras-3rd-Party-Integration": "dirac",
					},
				})
			} catch (error) {
				throw new Error(`Error creating Cerebras client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry({
		maxRetries: 6, // More retries to be patient with rate limits
		baseDelay: 5000, // Start with 5 second delay
		maxDelay: 60000, // Allow up to 60 second delays to respect rate limits
	})
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		const client = this.ensureClient()

		const toolParams = getOpenAIToolParams(tools as OpenAITool[])
		const openAiMessages = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages, undefined, this.getModel().info.supportsImages !== false),
		] as ChatCompletionCreateParamsStreaming["messages"]

		// Check if this is a reasoning model that uses thinking tags
		const modelId = this.getModel().id
		const isReasoningModel = modelId.includes("qwen")

		try {
			const model = this.getModel()
			const stream = await client.chat.completions.create({
				model: model.id,
				messages: openAiMessages,
				temperature: model.info.temperature ?? 0,
				stream: true,
				max_tokens: CEREBRAS_DEFAULT_MAX_TOKENS,
				...toolParams,
			} as ChatCompletionCreateParamsStreaming)

			// Handle streaming response
			let reasoning: string | null = null
			const toolCallProcessor = new ToolCallProcessor()

			for await (const chunk of stream as AsyncIterable<CerebrasChunk>) {
				const choices = chunk.choices
				const delta = choices?.[0]?.delta

				if (delta?.tool_calls) {
					yield* toolCallProcessor.processToolCallDeltas(
						delta.tool_calls as unknown as Parameters<typeof toolCallProcessor.processToolCallDeltas>[0],
					)
				}

				if (delta?.content) {
					const content = delta.content
					if (isReasoningModel) {
						const result = this.parseCerebrasReasoningContent(content, reasoning)
						reasoning = result.reasoning
						yield* result.chunks
					} else {
						yield { type: "text", text: content }
					}
				}

				if (chunk.usage) {
					const usage = chunk.usage
					const totalCost = this.calculateCost({
						inputTokens: usage.prompt_tokens || 0,
						outputTokens: usage.completion_tokens || 0,
					})
					yield {
						type: "usage",
						inputTokens: usage.prompt_tokens || 0,
						outputTokens: usage.completion_tokens || 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalCost,
					}
				}
			}
		} catch (error: any) {
			// Enhanced error handling for Cerebras API
			if (isRateLimited(error?.status) || error?.code === "rate_limit_exceeded") {
				// Rate limit error - will be handled by retry decorator with patient backoff
				throw new Error(`Cerebras API rate limit exceeded.`)
			}
			if (error?.status === 401) {
				throw new Error("Cerebras API authentication failed. Please check your API key.")
			}
			if (error?.status === 403) {
				throw new Error("Cerebras API access denied. Please check your API key permissions.")
			}
			if (isServerError(error?.status)) {
				// Server errors - retryable
				throw new Error(`Cerebras API server error (${error.status}): ${error.message || "Unknown server error"}`)
			}
			if (error?.status === 400) {
				// Client errors - not retryable
				throw new Error(`Cerebras API bad request: ${error.message || "Invalid request parameters"}`)
			}

			// Re-throw original error for other cases
			throw error
		}
	}

	// Parses reasoning content from Cerebras reasoning models that use think tags.
	// Returns updated reasoning state and chunks to yield.
	private parseCerebrasReasoningContent(
		content: string,
		reasoning: string | null,
	): { reasoning: string | null; chunks: any[] } {
		const chunks: any[] = []
		if (reasoning || content.includes("<think>")) {
			reasoning = (reasoning || "") + content
			const cleanContent = content.replace(/<think>/g, "").replace(/<\/think>/g, "")
			if (cleanContent.trim()) chunks.push({ type: "reasoning", reasoning: cleanContent })
			if (reasoning.includes("</think>")) reasoning = null
		} else {
			chunks.push({ type: "text", text: content })
		}
		return { reasoning, chunks }
	}

	getModel(): { id: string; info: ModelInfo } {
		const originalModelId = this.options.apiModelId
		let apiModelId = originalModelId
		if (originalModelId === "qwen-3-coder-480b-free") {
			apiModelId = "qwen-3-coder-480b"
			return { id: apiModelId, info: cerebrasModels[originalModelId as CerebrasModelId] }
		}

		if (originalModelId && originalModelId in cerebrasModels) {
			const id = originalModelId as CerebrasModelId
			return { id, info: cerebrasModels[id] }
		}
		return {
			id: cerebrasDefaultModelId,
			info: cerebrasModels[cerebrasDefaultModelId],
		}
	}

	/**
	 * Get rate limit information for the current model
	 *
	 * These limits are used for informational purposes and to calculate appropriate
	 * retry delays. Since Cerebras inference is extremely fast, users hit these limits
	 * quickly, so we need to be patient with retries to maximize usage efficiency.
	 *
	 * @returns Rate limit configuration for the model
	 */
	private getRateLimits(): { requestsPerMinute: number; tokensPerMinute: number } {
		const modelId = this.getModel().id

		switch (modelId) {
			case "qwen-3-coder-480b":
			case "qwen-3-coder-480b-free":
				return { requestsPerMinute: 10, tokensPerMinute: 150_000 }
			case "qwen-3-235b-a22b-instruct-2507":
			case "qwen-3-235b-a22b-thinking-2507":
				return { requestsPerMinute: 30, tokensPerMinute: 60_000 }
			case "gpt-oss-120b":
				return { requestsPerMinute: 30, tokensPerMinute: 64_000 }
			default:
				// Default rate limits for unknown models
				return { requestsPerMinute: 30, tokensPerMinute: 60_000 }
		}
	}

	private calculateCost({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number {
		const model = this.getModel()
		const inputPrice = model.info.inputPrice || 0
		const outputPrice = model.info.outputPrice || 0

		const inputCost = (inputPrice / 1_000_000) * inputTokens
		const outputCost = (outputPrice / 1_000_000) * outputTokens

		return inputCost + outputCost
	}
}
