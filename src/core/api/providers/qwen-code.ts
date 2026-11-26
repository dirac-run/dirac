import { ModelInfo, qwenCodeDefaultModelId } from "@shared/api"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { getQwenCachedCredentialPath } from "@/utils/qwenCodeCredentialPath"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { getCachedQwenCodeModels } from "./qwen-code-models"
import { QwenSubscriptionSession } from "./qwen-subscription-session"

const QWEN_SUBSCRIPTION_BASE_URL = "https://api.qwen.ai/compatible-mode/v1"

interface QwenCodeHandlerOptions extends CommonApiHandlerOptions {
	qwenCodeOauthPath?: string
	apiModelId?: string
	reasoningEffort?: string
	thinkingBudgetTokens?: number
}

export class QwenCodeHandler implements ApiHandler {
	private readonly session: QwenSubscriptionSession

	constructor(private readonly options: QwenCodeHandlerOptions) {
		this.session = new QwenSubscriptionSession(getQwenCachedCredentialPath(options.qwenCodeOauthPath), fetch)
	}

	private createClient(accessToken: string): OpenAI {
		return new OpenAI({
			apiKey: accessToken,
			baseURL: QWEN_SUBSCRIPTION_BASE_URL,
			organization: null,
			project: null,
			maxRetries: 0,
			// Identify Dirac honestly; gateway acceptance by third-party clients is not guaranteed.
			defaultHeaders: buildExternalBasicHeaders(),
			fetch: async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : input.toString())
				if (url.href !== `${QWEN_SUBSCRIPTION_BASE_URL}/chat/completions`) {
					throw new Error("Unsupported Qwen Subscription inference destination")
				}
				const response = await fetch(input, { ...init, redirect: "error" })
				if (response.status !== 405 && !response.headers.get("content-type")?.toLowerCase().includes("text/html"))
					return response

				// Do not expose gateway HTML (or pretend a WAF diagnosis is established).
				await response.body?.cancel()
				return new Response(
					JSON.stringify({
						error: {
							message: `Qwen Subscription gateway returned HTTP ${response.status}${response.status === 405 ? " (method not allowed)" : " with HTML instead of an API response"}. Verify subscription access with Qwen; this gateway may require Qwen-supported client access. Dirac identifies itself as Dirac, not Qwen Code.`,
						},
					}),
					{ status: response.ok ? 502 : response.status, headers: { "content-type": "application/json" } },
				)
			},
		})
	}

	private getThinkingParams(info: ModelInfo): { enable_thinking: boolean; thinking_budget?: number } {
		const effort = this.options.reasoningEffort
		const disabled = effort === "none" || effort === "off" || (!effort && this.options.thinkingBudgetTokens === 0)
		if (disabled && !info.thinkingAlwaysOn) return { enable_thinking: false }

		const effortBudget =
			effort === "minimal" || effort === "low" ? 4096 : ["high", "xhigh", "max"].includes(effort ?? "") ? 32768 : 16384
		return {
			enable_thinking: true,
			thinking_budget:
				this.options.thinkingBudgetTokens && this.options.thinkingBudgetTokens > 0
					? this.options.thinkingBudgetTokens
					: effortBudget,
		}
	}

	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const model = this.getModel()
		const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model: model.id,
			messages: [
				{ role: "system", content: systemPrompt },
				...convertToOpenAiMessages(messages, "qwen-code", model.info.supportsImages === true),
			],
			stream: true,
			stream_options: { include_usage: true },
			...getOpenAIToolParams(tools, this.options.enableParallelToolCalling),
			...this.getThinkingParams(model.info),
		}

		const accessToken = await this.session.accessToken()
		let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
		try {
			stream = await this.createClient(accessToken).chat.completions.create(request)
		} catch (error) {
			if (!(error instanceof OpenAI.APIError) || error.status !== 401 || this.options.disableRetries) throw error
			const refreshedToken = await this.session.accessToken(accessToken)
			stream = await this.createClient(refreshedToken).chat.completions.create(request)
		}

		// Only opening the HTTP stream is retried, never stream consumption or partially delivered output.
		const toolCallProcessor = new ToolCallProcessor()
		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta && "reasoning_content" in delta && typeof delta.reasoning_content === "string" && delta.reasoning_content) {
				yield { type: "reasoning", reasoning: delta.reasoning_content }
			}
			// Chat Completions content is a delta, not a cumulative snapshot. Repeated prefixes are valid text.
			if (delta?.content) yield { type: "text", text: delta.content }
			if (delta?.tool_calls) yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
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
		const models = getCachedQwenCodeModels(this.options.qwenCodeOauthPath)
		const configuredId = this.options.apiModelId
		const retired = configuredId === "qwen3-coder-plus" || configuredId === "qwen3-coder-flash"
		const id =
			configuredId && (!retired || Object.hasOwn(models, configuredId))
				? configuredId
				: (Object.keys(models)[0] ?? qwenCodeDefaultModelId)
		return { id, info: Object.hasOwn(models, id) ? models[id] : { supportsPromptCache: false } }
	}
}
