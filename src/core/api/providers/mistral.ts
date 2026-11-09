import { Mistral } from "@mistralai/mistralai"
import { HTTPClient } from "@mistralai/mistralai"
import { MistralModelId, ModelInfo, mistralDefaultModelId, mistralModels } from "@shared/api"
import { resolveReasoningEffortForModel } from "@shared/utils/reasoning-support"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStream } from "../transform/stream"
import { ToolCallProcessor } from "../transform/tool-call-processor"

type MistralTool = NonNullable<Parameters<Mistral["chat"]["stream"]>[0]["tools"]>[number]

interface MistralHandlerOptions extends CommonApiHandlerOptions {
	mistralApiKey?: string
	apiModelId?: string
	reasoningEffort?: string
}

export class MistralHandler implements ApiHandler {
	private options: MistralHandlerOptions
	private client: Mistral | undefined

	constructor(options: MistralHandlerOptions) {
		this.options = options
	}

	private ensureClient(): Mistral {
		if (!this.client) {
			if (!this.options.mistralApiKey) {
				throw new Error("Mistral API key is required")
			}
			try {
				const externalHeaders = buildExternalBasicHeaders()
				// Create HTTP client with custom fetch for proxy support
				// The Mistral SDK's HTTPClient passes a Request object to the fetcher,
				// but we need to extract the URL and init options to pass to our fetch wrapper
				// which properly handles proxy configuration in standalone mode (JetBrains/CLI)
				const httpClient = new HTTPClient({
					fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
						// Handle both string/URL and Request object inputs
						if (input instanceof Request) {
							Object.keys(externalHeaders).forEach((key) => {
								if (!input.headers.has(key)) {
									input.headers.set(key, externalHeaders[key])
								}
							})
							return fetch(input.url, {
								method: input.method,
								headers: input.headers,
								body: input.body,
								redirect: input.redirect,
								signal: input.signal,
								// duplex is required when sending a body stream in Node.js/undici
								duplex: input.body ? "half" : undefined,
								...init,
							} as RequestInit)
						}

						// Merge external headers with existing headers
						const mergedInit = {
							...init,
							headers: {
								...externalHeaders,
								...(init?.headers || {}),
							},
						}
						return fetch(input, mergedInit)
					},
				})

				this.client = new Mistral({
					apiKey: this.options.mistralApiKey,
					httpClient,
				})
			} catch (error) {
				throw new Error(`Error creating Mistral client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const supportsReasoningEffort = model.info.supportsReasoningEffort === true
		const reasoningEffort = resolveReasoningEffortForModel(model.id, model.info, this.options.reasoningEffort)
		const toolCallProcessor = new ToolCallProcessor()
		const stream = await client.chat
			.stream({
				model: model.id,
				temperature: model.info.temperature ?? 0,
				...(supportsReasoningEffort ? {
					topP: 0.95,
					// SDK 2.2's open enum predates low/medium; its serializer accepts these API values.
					reasoningEffort: reasoningEffort as Parameters<Mistral["chat"]["stream"]>[0]["reasoningEffort"],
				} : {}),
				messages: [
					{ role: "system", content: systemPrompt },
					...convertToMistralMessages(messages, model.info.supportsImages !== false, supportsReasoningEffort),
				],
				stream: true,
				tools: tools?.length ? (tools as (MistralTool & { type: "function" })[]) : undefined,
				toolChoice: tools?.length ? "any" : undefined,
			})
			.catch((err) => {
				// The Mistral SDK uses statusCode instead of status.
				if ("statusCode" in err && !("status" in err)) {
					err.status = err.statusCode
				}
				throw err
			})

		for await (const chunk of stream) {
			const delta = chunk.data.choices[0]?.delta
			if (typeof delta?.content === "string") {
				yield { type: "text", text: delta.content }
			} else if (Array.isArray(delta?.content)) {
				for (const part of delta.content) {
					if (part.type === "thinking") {
						const reasoning = part.thinking.map((inner) => inner.type === "text" ? inner.text : "").join("")
						if (reasoning) yield { type: "reasoning", reasoning }
					} else if (part.type === "text") {
						yield { type: "text", text: part.text }
					}
				}
			}
			if (delta?.toolCalls) {
				yield* toolCallProcessor.processToolCallDeltas(
					delta.toolCalls.map((toolCall, index) => ({
						index: toolCall.index ?? index,
						id: toolCall.id,
						type: "function",
						function: {
							name: toolCall.function.name,
							arguments:
								typeof toolCall.function.arguments === "string"
									? toolCall.function.arguments
									: JSON.stringify(toolCall.function.arguments),
						},
					})),
				)
			}

			if (chunk.data.usage) {
				const usage = chunk.data.usage
				// Older SDKs preserve this newer field under its wire name.
				const promptDetails = usage.prompt_tokens_details as { cached_tokens?: number } | undefined
				const cacheReadTokens = model.info.supportsPromptCache ? (promptDetails?.cached_tokens ?? 0) : 0
				yield {
					type: "usage",
					// Dirac's Mistral cost calculation expects uncached input tokens.
					inputTokens: (usage.promptTokens ?? 0) - cacheReadTokens,
					outputTokens: usage.completionTokens ?? 0,
					...(model.info.supportsPromptCache ? { cacheReadTokens } : {}),
				}
			}
		}
	}

	getModel(): { id: MistralModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in mistralModels) {
			const id = modelId as MistralModelId
			return { id, info: mistralModels[id] }
		}
		return {
			id: mistralDefaultModelId,
			info: mistralModels[mistralDefaultModelId],
		}
	}
}
