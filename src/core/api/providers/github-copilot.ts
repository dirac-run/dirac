import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { jsonHeaders } from "@shared/net"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { z } from "zod"
import { openAIToolToAnthropic } from "@/core/prompts/system-prompt/spec"
import {
    COPILOT_SPOOF_HEADERS,
    fetchCopilotModels,
    GITHUB_COPILOT_BASE_URL,
    getCopilotToken,
    githubCopilotModelSchema,
} from "@/integrations/github-copilot/api"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"
import { convertDiracStorageToAnthropicMessage, DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { DiracTool } from "@/shared/tools"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

export class GithubCopilotHandler implements ApiHandler {
	private options: CommonApiHandlerOptions
	private modelId: string

	constructor(options: CommonApiHandlerOptions & { apiModelId?: string }) {
		this.options = options
		this.modelId = options.apiModelId || "gpt-4o"
	}

	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[]): ApiStream {
		const githubToken = await githubCopilotAuthManager.getAccessToken()
		if (!githubToken) {
			throw new Error("Not authenticated with GitHub Copilot. Please sign in.")
		}

		const token = await getCopilotToken(githubToken)

		let modelData: z.infer<typeof githubCopilotModelSchema>["data"][0] | undefined
		try {
			const models = await fetchCopilotModels(token)
			modelData = models.find((m) => m.id === this.modelId)
		} catch (error) {
			Logger.error("[github-copilot] Failed to fetch models:", error)
		}

		// Fallback to defaults if model discovery fails
		const isAnthropicFormat = modelData?.supported_endpoints?.includes("/v1/messages") ?? false
		const url = isAnthropicFormat ? `${GITHUB_COPILOT_BASE_URL}/v1/messages` : `${GITHUB_COPILOT_BASE_URL}/chat/completions`

		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			...jsonHeaders(),
			...COPILOT_SPOOF_HEADERS,
		}
		const toolParams = getOpenAIToolParams(tools as OpenAITool[])
		const anthropicTools = tools
			? (tools as (OpenAITool | AnthropicTool)[]).map((tool) => {
					// If it's already an Anthropic tool, return it as is
					if ("input_schema" in tool) {
						return tool as AnthropicTool
					}
					// Otherwise convert from OpenAI format
					return openAIToolToAnthropic(tool as OpenAITool)
				})
			: undefined

		let body: any
		if (isAnthropicFormat) {
			body = {
				model: this.modelId,
				system: systemPrompt,
				messages: messages.map((m) => convertDiracStorageToAnthropicMessage(m)),
				tools: anthropicTools,
				tool_choice: anthropicTools ? { type: "auto" } : undefined,
				max_tokens: modelData?.capabilities.limits.max_output_tokens || 4096,
				stream: true,
			}
		} else {
			body = {
				model: this.modelId,
				messages: [
					{ role: "system", content: systemPrompt },
					...convertToOpenAiMessages(messages, undefined, this.getModel().info.supportsImages !== false),
				],
				...toolParams,
				max_tokens: modelData?.capabilities.limits.max_output_tokens || 4096,
				stream: true,
			}
		}

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`GitHub Copilot API error: ${response.status} ${response.statusText} - ${errorText}`)
		}

		if (!response.body) {
			throw new Error("No response body from GitHub Copilot API")
		}

		yield* this.handleStream(response.body, isAnthropicFormat)
	}

	// Parses an Anthropic-format SSE stream (tool_use blocks, text deltas, usage).
	private *parseAnthropicStreamEvent(
		json: any,
		lastStartedToolCall: { id: string; name: string; arguments: string },
	): Generator<any> {
		if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
			lastStartedToolCall.id = json.content_block.id
			lastStartedToolCall.name = json.content_block.name
			lastStartedToolCall.arguments = ""
			yield {
				type: "tool_calls",
				tool_call: {
					call_id: lastStartedToolCall.id,
					function: { id: lastStartedToolCall.id, name: lastStartedToolCall.name, arguments: "" },
				},
			}
		} else if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta") {
			if (lastStartedToolCall.id) {
				yield {
					type: "tool_calls",
					tool_call: {
						...lastStartedToolCall,
						function: {
							...lastStartedToolCall,
							id: lastStartedToolCall.id,
							name: lastStartedToolCall.name,
							arguments: json.delta.partial_json,
						},
					},
				}
			}
		} else if (json.type === "content_block_stop") {
			lastStartedToolCall.id = ""
			lastStartedToolCall.name = ""
			lastStartedToolCall.arguments = ""
		}
		if (json.type === "content_block_delta" && json.delta?.text) {
			yield { type: "text", text: json.delta.text }
		} else if (json.type === "message_delta" && json.usage) {
			yield { type: "usage", inputTokens: json.usage.input_tokens || 0, outputTokens: json.usage.output_tokens || 0 }
		}
	}

	// Parses an OpenAI-format SSE stream (tool call deltas, text content, usage).
	private *parseOpenAiStreamEvent(json: any, toolCallProcessor: ToolCallProcessor): Generator<any> {
		const delta = json.choices?.[0]?.delta
		if (delta?.tool_calls) yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
		if (delta?.content) yield { type: "text", text: delta.content }
		if (json.usage)
			yield { type: "usage", inputTokens: json.usage.prompt_tokens || 0, outputTokens: json.usage.completion_tokens || 0 }
	}

	private async *handleStream(body: ReadableStream<Uint8Array>, isAnthropicFormat: boolean): ApiStream {
		const toolCallProcessor = new ToolCallProcessor()
		const lastStartedToolCall = { id: "", name: "", arguments: "" }
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || !trimmed.startsWith("data: ")) continue
					const data = trimmed.slice(6)
					if (data === "[DONE]") continue

					try {
						const json = JSON.parse(data)
						yield* isAnthropicFormat
							? this.parseAnthropicStreamEvent(json, lastStartedToolCall)
							: this.parseOpenAiStreamEvent(json, toolCallProcessor)
					} catch (e) {
						// Incomplete chunks are expected during streaming — log for visibility
						Logger.debug("GitHub Copilot: incomplete SSE chunk:", data, e)
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.modelId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: "GitHub Copilot Native API",
			},
		}
	}
}
