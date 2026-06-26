import { Anthropic } from "@anthropic-ai/sdk"
import {
	CLAUDE_SONNET_1M_SUFFIX,
	ModelInfo,
	OPENROUTER_PROVIDER_PREFERENCES,
	openRouterClaudeOpus461mModelId,
	openRouterClaudeSonnet41mModelId,
	openRouterClaudeSonnet451mModelId,
	openRouterClaudeSonnet461mModelId,
	stripOpenRouterPreset,
} from "@shared/api"
import { normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import { GEMINI_MAX_OUTPUT_TOKENS, shouldSkipReasoningForModel, supportsReasoningEffortForModel } from "@utils/model-utils"
import OpenAI from "openai"
import { ChatCompletionTool } from "openai/resources/chat/completions"
import { convertToOpenAiMessages, sanitizeGeminiMessages } from "./openai-format"
import { addReasoningContent, convertToR1Format } from "./r1-format"
import { getOpenAIToolParams } from "./tool-call-processor"

function needsExplicitCacheControl(baseModelId: string, info: ModelInfo): boolean {
	// Honor the capability flag the model registry computes (refreshOpenRouterModels.ts),
	// so cache-capable models don't silently miss caching just because they're absent from
	// the id list below. The id checks remain as a fallback for envelope-honoring families
	// (Anthropic/MiniMax shapes) that may not be flagged in the registry yet.
	return info.supportsPromptCache || baseModelId.startsWith("anthropic/") || baseModelId.startsWith("minimax/")
}

export async function createOpenRouterStream(
	client: OpenAI,
	systemPrompt: string,
	messages: Anthropic.Messages.MessageParam[],
	model: { id: string; info: ModelInfo },
	reasoningEffort?: string,
	thinkingBudgetTokens?: number,
	openRouterProviderSorting?: string,
	tools?: Array<ChatCompletionTool>,
	enableParallelToolCalling?: boolean,
) {
	const baseModelId = stripOpenRouterPreset(model.id)
	// Convert Anthropic messages to OpenAI format
	let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
		{ role: "system", content: systemPrompt },
		...convertToOpenAiMessages(messages as any, undefined, model.info.supportsImages !== false),
	]

	const isClaude1m =
		baseModelId === openRouterClaudeSonnet41mModelId ||
		baseModelId === openRouterClaudeSonnet451mModelId ||
		baseModelId === openRouterClaudeSonnet461mModelId ||
		baseModelId === openRouterClaudeOpus461mModelId
	if (isClaude1m) {
		// remove the custom :1m suffix, to create the model id openrouter API expects
		const presetIndex = model.id.indexOf("@preset/")
		if (presetIndex !== -1) {
			const beforePreset = model.id.substring(0, presetIndex)
			const afterPreset = model.id.substring(presetIndex)
			model.id = beforePreset.slice(0, -CLAUDE_SONNET_1M_SUFFIX.length) + afterPreset
		} else {
			model.id = model.id.slice(0, -CLAUDE_SONNET_1M_SUFFIX.length)
		}
	}

	// Sanitize messages for Gemini models (removes tool_calls without reasoning_details)
	openAiMessages = sanitizeGeminiMessages(openAiMessages, baseModelId)

	const isDeepSeek = baseModelId.includes("deepseek")
	const supportsReasoning = model.info.supportsReasoning
	const requestedEffort = normalizeOpenaiReasoningEffort(reasoningEffort)
	const isThinkingEnabled = supportsReasoning && requestedEffort !== "none"
	const isR1 = baseModelId.includes("r1") || baseModelId.includes("reasoner")
	const shouldAddReasoningContent = isDeepSeek && (isR1 || supportsReasoning)

	// prompt caching: https://openrouter.ai/docs/prompt-caching
	// this was initially specifically for claude models (some models may 'support prompt caching' automatically without this)
	// gate the cache_control envelope by the registry capability flag instead of a hardcoded id list
	if (needsExplicitCacheControl(baseModelId, model.info)) {
		openAiMessages[0] = {
			role: "system",
			content: [
				{
					type: "text",
					text: systemPrompt,
					// @ts-expect-error-next-line
					cache_control: { type: "ephemeral" },
				},
			],
		}
		// Add cache_control to the last two user messages
		// (note: this works because we only ever add one user message at a time, but if we added multiple we'd need to mark the user message before the last assistant message)
		const lastTwoUserMessages = openAiMessages.filter((msg) => msg.role === "user").slice(-2)
		lastTwoUserMessages.forEach((msg) => {
			if (typeof msg.content === "string") {
				msg.content = [{ type: "text", text: msg.content }]
			}
			if (Array.isArray(msg.content)) {
				// NOTE: this is fine since env details will always be added at the end. but if it weren't there, and the user added a image_url type message, it would pop a text part before it and then move it after to the end.
				let lastTextPart = msg.content.filter((part) => part.type === "text").pop()

				if (!lastTextPart) {
					lastTextPart = { type: "text", text: "..." }
					msg.content.push(lastTextPart)
				}
				// @ts-expect-error-next-line
				lastTextPart["cache_control"] = { type: "ephemeral" }
			}
		})
	}

	let temperature: number | undefined = model.info.temperature ?? (baseModelId.startsWith("anthropic/") ? undefined : 0)
	let topP: number | undefined
	if (
		baseModelId.startsWith("deepseek/deepseek-r1") ||
		baseModelId === "perplexity/sonar-reasoning" ||
		baseModelId === "qwen/qwq-32b:free" ||
		baseModelId === "qwen/qwq-32b"
	) {
		// Recommended values from DeepSeek
		temperature = 0.3
		topP = 0.95
		openAiMessages = convertToR1Format(
			[{ role: "user", content: systemPrompt }, ...messages],
			model.info.supportsImages !== false,
		)
	}

	if (shouldAddReasoningContent) {
		openAiMessages = addReasoningContent(openAiMessages, messages as any, {
			onlyIfToolCall: isDeepSeek && !isR1,
		})
	}

	const supportsReasoningEffort = supportsReasoningEffortForModel(baseModelId)

	let reasoning: { max_tokens: number } | undefined
	switch (baseModelId) {
		case "anthropic/claude-opus-4.7":
		case "anthropic/claude-4.7-opus":
		case "anthropic/claude-opus-4.6":
		case "anthropic/claude-haiku-4.5":
		case "anthropic/claude-4.5-haiku":
		case "anthropic/claude-sonnet-4.6":
		case "anthropic/claude-4.6-sonnet":
		case "anthropic/claude-sonnet-4.5":
		case "anthropic/claude-4.5-sonnet":
		case "anthropic/claude-sonnet-4":
		case "anthropic/claude-opus-4.5":
		case "anthropic/claude-opus-4.1":
		case "anthropic/claude-opus-4":
		case "anthropic/claude-3.7-sonnet":
		case "anthropic/claude-3.7-sonnet:beta":
		case "anthropic/claude-3.7-sonnet:thinking":
		case "anthropic/claude-3-7-sonnet":
		case "anthropic/claude-3-7-sonnet:beta":
			const budget_tokens = thinkingBudgetTokens || 0
			const reasoningOn = budget_tokens !== 0
			if (reasoningOn) {
				temperature = undefined // extended thinking does not support non-1 temperature
				reasoning = { max_tokens: budget_tokens }
			}
			break
		default:
			if (thinkingBudgetTokens && model.info?.thinkingConfig && thinkingBudgetTokens > 0 && !supportsReasoningEffort) {
				temperature = undefined // extended thinking does not support non-1 temperature
				reasoning = { max_tokens: thinkingBudgetTokens }
				break
			}
	}

	const providerPreferences = OPENROUTER_PROVIDER_PREFERENCES[baseModelId]
	if (providerPreferences) {
		openRouterProviderSorting = undefined
	}

	const normalizedReasoningEffort = reasoningEffort !== undefined ? normalizeOpenaiReasoningEffort(reasoningEffort) : undefined
	const reasoningEffortValue = supportsReasoningEffort ? normalizedReasoningEffort : undefined
	// Skip reasoning for models that don't support it (e.g., devstral, grok-4), or when effort explicitly disables it.
	const includeReasoning = !shouldSkipReasoningForModel(baseModelId) && reasoningEffortValue !== "none"
	const reasoningPayload =
		reasoning ?? (reasoningEffortValue && reasoningEffortValue !== "none" ? { effort: reasoningEffortValue } : undefined)
	const maxTokens = Math.min(model.info.maxTokens || GEMINI_MAX_OUTPUT_TOKENS, GEMINI_MAX_OUTPUT_TOKENS)

	if (isDeepSeek && supportsReasoning && !isR1) {
		if (isThinkingEnabled) {
			temperature = undefined
			topP = undefined
		}
	}

	const requestPayload: Record<string, unknown> = {
		model: model.id,
		...(maxTokens ? { max_tokens: maxTokens } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		...(topP !== undefined ? { top_p: topP } : {}),
		messages: openAiMessages,
		stream: true,
		stream_options: { include_usage: true },
		include_reasoning: includeReasoning,
		...(reasoningPayload ? { reasoning: reasoningPayload } : {}),
		...(isDeepSeek && supportsReasoning && !isR1
			? {
					thinking: {
						type: isThinkingEnabled ? "enabled" : "disabled",
						...(isThinkingEnabled && thinkingBudgetTokens ? { budget_tokens: thinkingBudgetTokens } : {}),
					},
					...(isThinkingEnabled ? { reasoning_effort: requestedEffort } : {}),
				}
			: {}),
		...(openRouterProviderSorting && !providerPreferences ? { provider: { sort: openRouterProviderSorting } } : {}),
		...(providerPreferences ? { provider: providerPreferences } : {}),
		...(isClaude1m ? { provider: { order: ["anthropic", "google-vertex/global"], allow_fallbacks: false } } : {}),
		...getOpenAIToolParams(tools, !!enableParallelToolCalling),
	}

	// @ts-expect-error-next-line
	const stream = await client.chat.completions.create(requestPayload)

	return stream
}
