import OpenAI from "openai"
import { ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { ApiStream } from "../transform/stream"
import { buildResponseCreateParams, mapResponseTools, processResponsesEvents } from "./openai-responses-utils"
import { ChatCompletionTool } from "openai/resources/chat/completions"

interface OpenAiResponsesCompatibleHandlerOptions extends CommonApiHandlerOptions {
	openAiApiKey?: string
	openAiBaseUrl?: string
	openAiModelId?: string
	openAiModelInfo?: ModelInfo
	reasoningEffort?: string
}

export class OpenAiResponsesCompatibleHandler implements ApiHandler {
	private options: OpenAiResponsesCompatibleHandlerOptions
	private client: OpenAI | undefined
	private abortController?: AbortController

	constructor(options: OpenAiResponsesCompatibleHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.openAiApiKey) {
				throw new Error("OpenAI API key is required")
			}
			try {
				this.client = createOpenAIClient({
					apiKey: this.options.openAiApiKey,
					baseURL: this.options.openAiBaseUrl,
				})
			} catch (error) {
				throw new Error(`Error creating OpenAI client: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: ChatCompletionTool[]): ApiStream {
		// Add web_search tool for OpenAI
		const finalTools = [...(tools || [])]
		finalTools.push({ type: "web_search" } as any)
		const client = this.ensureClient()
		const model = this.getModel()
		const { input } = convertToOpenAIResponsesInput(messages, { usePreviousResponseId: false })
		const responseTools = mapResponseTools(finalTools, model.info.supportsStrictTools)
		this.abortController = new AbortController()

		const params = buildResponseCreateParams({
			modelId: model.id,
			systemPrompt,
			input,
			tools: responseTools,
			reasoningEffort: this.options.reasoningEffort,
			store: true,
		})

		const stream = await client.responses.create(params, { signal: this.abortController.signal })
		yield* processResponsesEvents(stream, model.info)
	}

	abort(): void {
		this.abortController?.abort()
		this.abortController = undefined
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.openAiModelId ?? "",
			info: this.options.openAiModelInfo ?? openAiModelInfoSaneDefaults,
		}
	}
}
