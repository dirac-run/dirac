import { StateManager } from "@core/storage/StateManager"
import { type ModelInfo, unbiasedDefaultModelId, unbiasedModels } from "@shared/api"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { isUnbiasedOAuthApiKey } from "@/integrations/unbiased/oauth-account"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import type { ApiHandler, CommonApiHandlerOptions } from "../types"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { formatOpenAiCompatibleUsage } from "../transform/openai-usage"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { getCachedUnbiasedModels } from "../unbiased/unbiased-models"

interface UnbiasedHandlerOptions extends CommonApiHandlerOptions {
	unbiasedApiKey?: string
	apiModelId?: string
}

export class UnbiasedHandler implements ApiHandler {
	private client: OpenAI | undefined
	private abortController: AbortController | undefined
	private readonly isSubscription: boolean

	constructor(private readonly options: UnbiasedHandlerOptions) {
		// Bind pricing to this handler's key so later default-account changes cannot alter an in-flight request.
		this.isSubscription =
			StateManager.isInitialized() &&
			isUnbiasedOAuthApiKey(options.unbiasedApiKey, StateManager.get().getGlobalStateKey("unbiasedOAuthApiKeyHash"))
	}

	private ensureClient(): OpenAI {
		if (!this.options.unbiasedApiKey) throw new Error("Unbiased API key is required. Sign in or enter a key in settings.")
		this.client ??= createOpenAIClient({
			baseURL: "https://api.unbiased.ai/v1",
			apiKey: this.options.unbiasedApiKey,
		})
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
		const model = this.getModel()
		const stream = await this.ensureClient().chat.completions.create(
			{
				model: model.id,
				max_tokens: model.info.maxTokens,
				messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages, undefined, true)],
				stream: true,
				stream_options: { include_usage: true },
				...getOpenAIToolParams(tools),
			},
			{ signal },
		)
		const toolCallProcessor = new ToolCallProcessor()
		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) yield { type: "text", text: delta.content }
			if (delta?.tool_calls) yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			if (chunk.usage) {
				const usage = formatOpenAiCompatibleUsage(chunk.usage, model.info)
				// A provider-reported API value is not an incremental charge on the monthly plan.
				if (this.isSubscription) usage.totalCost = 0
				yield usage
			}
		}
	}

	abort(): void {
		this.abortController?.abort()
	}

	getModel(): { id: string; info: ModelInfo } {
		const models = getCachedUnbiasedModels(
			this.options.unbiasedApiKey,
			StateManager.isInitialized() ? StateManager.get() : undefined,
		)
		const configuredId = this.options.apiModelId
		// Ignore an unrelated provider's shared mode ID, but retain Pareto versions across cache expiry/restarts.
		const id =
			configuredId && (models?.[configuredId] || configuredId === "pareto" || configuredId.startsWith("pareto-"))
				? configuredId
				: unbiasedDefaultModelId
		const modelInfo: ModelInfo =
			models?.[id] || (id === unbiasedDefaultModelId ? unbiasedModels.pareto : { supportsPromptCache: false })
		const info = this.isSubscription
			? { ...modelInfo, inputPrice: 0, outputPrice: 0, cacheReadsPrice: 0, cacheWritesPrice: 0 }
			: modelInfo
		return { id, info }
	}
}
