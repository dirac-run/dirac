import { type ModelInfo, type AtlasCloudModelId, atlascloudDefaultModelId, atlascloudModels } from "@shared/api"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

interface AtlasCloudHandlerOptions extends CommonApiHandlerOptions {
	atlascloudApiKey?: string
	apiModelId?: string
}

export class AtlasCloudHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private readonly options: AtlasCloudHandlerOptions) {}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.atlascloudApiKey) {
				throw new Error("Atlas Cloud API key is required")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: "https://api.atlascloud.ai/v1",
					apiKey: this.options.atlascloudApiKey,
				})
			} catch (error) {
				throw new Error(`Error creating Atlas Cloud client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		// Every model Atlas Cloud serves takes the plain OpenAI chat shape with a
		// system role; none of them need the R1 user/assistant reformatting.
		const convertedMessages = convertToOpenAiMessages(messages, undefined, model.info.supportsImages !== false)
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertedMessages,
		]

		const stream = await client.chat.completions.create({
			model: model.id,
			messages: openAiMessages,
			temperature: 0,
			stream: true,
			stream_options: { include_usage: true },
			...getOpenAIToolParams(tools),
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
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens ?? 0,
					outputTokens: chunk.usage.completion_tokens ?? 0,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.apiModelId

		if (modelId !== undefined && modelId in atlascloudModels) {
			return { id: modelId, info: atlascloudModels[modelId as AtlasCloudModelId] }
		}
		if (modelId !== undefined) {
			// Fail loudly: silently swapping the requested model for the default
			// misattributes cost/behavior to a model the user never selected.
			Logger.error(
				`[AtlasCloudHandler] Unknown Atlas Cloud model '${modelId}'; falling back to ${atlascloudDefaultModelId}. Available: ${Object.keys(atlascloudModels).join(", ")}`,
			)
		}
		return { id: atlascloudDefaultModelId, info: atlascloudModels[atlascloudDefaultModelId] }
	}
}
