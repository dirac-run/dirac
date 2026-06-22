import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { ApiProvider } from "@/shared/api"
import {
    DiracAssistantRedactedThinkingBlock,
    DiracAssistantThinkingBlock,
    DiracAssistantToolUseBlock,
    DiracContent,
    DiracImageContentBlock,
    DiracStorageMessage,
    DiracTextContentBlock,
    DiracUserToolResultContentBlock,
} from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"

// OpenAI API has a maximum tool call ID length of 40 characters
const MAX_TOOL_CALL_ID_LENGTH = 40

/**
 * Determines if a given tool ID follows the OpenAI Responses API format for tool calls.
 * OpenAI tool call IDs start with "fc_" and are exactly 53 characters long.
 *
 * @param callId - The tool ID to check
 * @returns True if the tool ID matches the OpenAI Responses API format, false otherwise
 */
function isOpenAIResponseToolId(callId: string): boolean {
	return callId.startsWith("fc_") && callId.length === 53
}

/**
 * Transforms a tool ID to a consistent format for OpenAI's Chat Completions API.
 * NOTE: We do not want to transform tool IDs for non-OpenAI providers that may have different requirements.
 * This function MUST be used for both tool_calls[].id (assistant) and tool_call_id (tool result)
 * to ensure they match - otherwise OpenAI will reject the request with:
 * "Invalid parameter: 'tool_call_id' of 'xxx' not found in 'tool_calls' of previous message."
 *
 * @param toolId - The original tool ID from Dirac/Anthropic format
 * @param provider - The API provider that the OpenAI formatted messages will be sent to
 * @returns The transformed ID suitable for OpenAI API
 */
function transformToolCallIdForNativeApi(toolId: string, provider?: ApiProvider): string {
	// OpenAI Responses API uses "fc_" prefix with 53 char length
	// Convert these to "call_" prefix format for Chat Completions API
	if (isOpenAIResponseToolId(toolId)) {
		// Use the last 33 chars + "call_" (5 chars) to stay under the 40-char limit.
		return `call_${toolId.slice(toolId.length - (MAX_TOOL_CALL_ID_LENGTH - 5))}`
	}
	if (provider !== "openai-native") {
		return toolId
	}
	// Ensure ID doesn't exceed max length
	if (toolId.length > MAX_TOOL_CALL_ID_LENGTH) {
		return toolId.slice(0, MAX_TOOL_CALL_ID_LENGTH)
	}
	return toolId
}

// Builds an image_url object from a Dirac image content block.
function imageBlockToImageUrl(part: DiracImageContentBlock): { type: "image_url"; image_url: { url: string } } {
	// source is a discriminated union (base64 | url); narrow by type to read the right field.
	const url = part.source.type === "base64" ? `data:${part.source.media_type};base64,${part.source.data}` : part.source.url
	return { type: "image_url", image_url: { url } }
}

// Converts a single tool_result block's content to a string, deferring images to a separate user message.
function convertToolResultContent(
	toolMessage: DiracUserToolResultContentBlock,
	supportsImages: boolean,
	deferredImages: DiracImageContentBlock[],
): string {
	if (typeof toolMessage.content === "string") return toolMessage.content
	if (!Array.isArray(toolMessage.content)) return ""
	return (
		toolMessage.content
			.map((part) => {
				if (part.type === "image") {
					if (supportsImages) deferredImages.push(part as DiracImageContentBlock)
					return "(see following user message for image)"
				}
				return part.type === "text" ? part.text : ""
			})
			.join("\n") ?? ""
	)
}

// Converts user-role array content: tool_results first, then deferred images, then non-tool blocks.
function convertUserMessage(
	content: DiracContent[],
	provider: ApiProvider | undefined,
	supportsImages: boolean,
	openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
): void {
	const { nonToolMessages, toolMessages } = content.reduce<{
		nonToolMessages: (DiracTextContentBlock | DiracImageContentBlock)[]
		toolMessages: DiracUserToolResultContentBlock[]
	}>(
		(acc, part) => {
			if (part.type === "tool_result") acc.toolMessages.push(part as DiracUserToolResultContentBlock)
			else if (part.type === "text" || part.type === "image")
				acc.nonToolMessages.push(part as DiracTextContentBlock | DiracImageContentBlock)
			return acc
		},
		{ nonToolMessages: [], toolMessages: [] },
	)

	// Tool results must follow the tool use messages
	const deferredImages: DiracImageContentBlock[] = []
	for (const toolMessage of toolMessages) {
		openAiMessages.push({
			role: "tool",
			tool_call_id: transformToolCallIdForNativeApi(toolMessage.tool_use_id, provider),
			content: convertToolResultContent(toolMessage, supportsImages, deferredImages),
		})
	}

	if (deferredImages.length > 0) {
		openAiMessages.push({ role: "user", content: deferredImages.map(imageBlockToImageUrl) })
	}

	if (nonToolMessages.length > 0) {
		openAiMessages.push({
			role: "user",
			content: nonToolMessages.map((part) => {
				if (part.type === "image") return supportsImages ? imageBlockToImageUrl(part) : { type: "text", text: "[Image]" }
				return { type: "text", text: part.text || "" }
			}),
		})
	}
}

// Collects reasoning_details from text blocks and tool_use blocks matching a tool ID.
function collectReasoningDetails(
	nonToolMessages: DiracContent[],
	toolMessages: DiracAssistantToolUseBlock[],
): any[] {
	const reasoningDetails: any[] = []
	const isTextBlock = (part: any): part is DiracTextContentBlock => part.type === "text"
	const isThinkingBlock = (part: any): part is DiracAssistantThinkingBlock => part.type === "thinking"

	for (const part of nonToolMessages) {
		if (isTextBlock(part) && part.reasoning_details) {
			if (Array.isArray(part.reasoning_details)) reasoningDetails.push(...part.reasoning_details)
			else reasoningDetails.push(part.reasoning_details)
		}
	}

	for (const toolMessage of toolMessages) {
		const toolDetails = toolMessage.reasoning_details
		const toolId = toolMessage.id
		if (!toolDetails) continue
		if (Array.isArray(toolDetails)) {
			const validDetails = toolDetails.filter((detail: any) => detail?.id === toolId)
			if (validDetails.length > 0) reasoningDetails.push(...validDetails)
		} else if ((toolDetails as ReasoningDetail | undefined)?.id === toolId) {
			reasoningDetails.push(toolDetails)
		}
	}

	return reasoningDetails
}

// Converts assistant-role array content: text, thinking, tool_use, and reasoning_details.
function convertAssistantMessage(
	content: DiracContent[],
	provider: ApiProvider | undefined,
	openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
): void {
	const { nonToolMessages, toolMessages } = content.reduce<{
		nonToolMessages: (
			| DiracTextContentBlock
			| DiracImageContentBlock
			| DiracAssistantThinkingBlock
			| DiracAssistantRedactedThinkingBlock
		)[]
		toolMessages: DiracAssistantToolUseBlock[]
	}>(
		(acc, part) => {
			if (part.type === "tool_use") acc.toolMessages.push(part as DiracAssistantToolUseBlock)
			else if (
				part.type === "text" ||
				part.type === "image" ||
				part.type === "thinking" ||
				part.type === "redacted_thinking"
			) {
				acc.nonToolMessages.push(
					part as
						| DiracTextContentBlock
						| DiracImageContentBlock
						| DiracAssistantThinkingBlock
						| DiracAssistantRedactedThinkingBlock,
				)
			}
			return acc
		},
		{ nonToolMessages: [], toolMessages: [] },
	)

	const contentText =
		nonToolMessages.length > 0
			? nonToolMessages
					.map((part) =>
						part.type === "text" && (part as DiracTextContentBlock).text ? (part as DiracTextContentBlock).text : "",
					)
					.join("\n")
			: undefined

	const tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[] = toolMessages.map((toolMessage) => ({
		id: transformToolCallIdForNativeApi(toolMessage.id, provider),
		type: "function" as const,
		function: { name: toolMessage.name, arguments: JSON.stringify(toolMessage.input) },
	}))

	const hasToolCalls = tool_calls.length > 0
	const hasMeaningfulContent = contentText !== undefined && contentText.trim() !== ""
	const finalContent = hasMeaningfulContent ? contentText : hasToolCalls ? null : ""

	const reasoningDetails = collectReasoningDetails(nonToolMessages, toolMessages)
	const consolidatedReasoningDetails = reasoningDetails.length > 0 ? consolidateReasoningDetails(reasoningDetails) : []

	openAiMessages.push({
		role: "assistant",
		content: finalContent,
		tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
		// @ts-expect-error
		reasoning_details: consolidatedReasoningDetails.length > 0 ? consolidatedReasoningDetails : undefined,
	})
}

/**
 * Converts an array of DiracStorageMessage objects to OpenAI's Completions API format.
 *
 * Handles conversion of Dirac-specific content types (tool uses, tool results, images, reasoning details)
 * into OpenAI's expected message structure, including tool_calls and tool_call_id fields.
 *
 * @param anthropicMessages - Array of DiracStorageMessage objects to be converted
 * @param provider - Optional parameter to indicate the API provider, which may affect ID transformation logic
 * @param supportsImages - Whether the model supports image attachments
 * @returns Array of OpenAI.Chat.ChatCompletionMessageParam objects
 */
export function convertToOpenAiMessages(
	anthropicMessages: Omit<DiracStorageMessage, "modelInfo">[],
	provider?: ApiProvider,
	supportsImages = true,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			openAiMessages.push({ role: anthropicMessage.role, content: anthropicMessage.content })
			continue
		}
		if (anthropicMessage.role === "user") {
			convertUserMessage(anthropicMessage.content, provider, supportsImages, openAiMessages)
		} else if (anthropicMessage.role === "assistant") {
			convertAssistantMessage(anthropicMessage.content, provider, openAiMessages)
		}
	}

	return openAiMessages
}

// Type for OpenRouter's reasoning detail elements
type ReasoningDetail = {
	type: string
	text?: string
	data?: string
	signature?: string | null
	id?: string | null
	format: string
	index?: number
}

function consolidateReasoningDetails(reasoningDetails: ReasoningDetail[]): ReasoningDetail[] {
	if (!reasoningDetails || reasoningDetails.length === 0) {
		return []
	}

	const groupedByIndex = new Map<number, ReasoningDetail[]>()

	for (const detail of reasoningDetails) {
		if (detail.type === "reasoning.encrypted" && !detail.data) continue

		const index = detail.index ?? 0
		if (!groupedByIndex.has(index)) {
			groupedByIndex.set(index, [])
		}
		groupedByIndex.get(index)!.push(detail)
	}

	const consolidated: ReasoningDetail[] = []

	for (const [index, details] of groupedByIndex.entries()) {
		let concatenatedText = ""
		let signature: string | undefined
		let id: string | undefined
		let format = "unknown"
		let type = "reasoning.text"

		for (const detail of details) {
			if (detail.text) {
				concatenatedText += detail.text
			}
			if (detail.signature) {
				signature = detail.signature
			}
			if (detail.id) {
				id = detail.id
			}
			if (detail.format) {
				format = detail.format
			}
			if (detail.type) {
				type = detail.type
			}
		}

		if (concatenatedText) {
			const consolidatedEntry: ReasoningDetail = {
				type: type,
				text: concatenatedText,
				signature: signature,
				id: id,
				format: format,
				index: index,
			}
			consolidated.push(consolidatedEntry)
		}

		let lastDataEntry: ReasoningDetail | undefined
		for (const detail of details) {
			if (detail.data) {
				lastDataEntry = {
					type: detail.type,
					data: detail.data,
					signature: detail.signature,
					id: detail.id,
					format: detail.format,
					index: index,
				}
			}
		}
		if (lastDataEntry) {
			consolidated.push(lastDataEntry)
		}
	}

	return consolidated
}

const UNIQUE_ERROR_TOOL_NAME = "_dirac_error_unknown_function_"

export function convertToAnthropicMessage(completion: OpenAI.Chat.Completions.ChatCompletion): Anthropic.Messages.Message {
	const openAiMessage = completion.choices[0].message
	const anthropicMessage: Anthropic.Messages.Message = {
		id: completion.id,
		type: "message",
		role: openAiMessage.role,
		content: [
			{
				type: "text",
				text: openAiMessage.content || "",
				citations: null,
			},
		],
		model: completion.model,
		stop_reason: (() => {
			switch (completion.choices[0].finish_reason) {
				case "stop":
					return "end_turn"
				case "length":
					return "max_tokens"
				case "tool_calls":
					return "tool_use"
				case "content_filter":
				default:
					return null
			}
		})(),
		container: null,
		stop_details: null,

		stop_sequence: null,
		usage: {
			input_tokens: completion.usage?.prompt_tokens || 0,
			output_tokens: completion.usage?.completion_tokens || 0,
			cache_creation_input_tokens: null,
			cache_read_input_tokens: null,
			cache_creation: null,
			inference_geo: null,
			server_tool_use: null,
			service_tier: null,
		},
	}
	try {
		if (openAiMessage?.tool_calls?.length) {
			const functionCalls = openAiMessage.tool_calls.filter((tc: any) => tc?.type === "function" && tc.function)
			if (functionCalls.length > 0) {
				anthropicMessage.content.push(
					...functionCalls.map((toolCall: any): Anthropic.ToolUseBlock => {
						let parsedInput = {}
						try {
							parsedInput = JSON.parse(toolCall.function?.arguments || "{}")
						} catch (error) {
							Logger.error("Failed to parse tool arguments:", error)
						}
						return {
							type: "tool_use",
							id: toolCall.id,
							name: toolCall.function?.name || UNIQUE_ERROR_TOOL_NAME,
							input: parsedInput,
							caller: { type: "direct" },
						}
					}),
				)
			}
		}
	} catch (error) {
		Logger.error("Error converting OpenAI message to Anthropic format:", error)
	}

	return anthropicMessage
}

export function sanitizeGeminiMessages(
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
	modelId: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	if (!modelId.includes("gemini")) {
		return messages
	}

	// OpenRouter adds a non-standard reasoning_details field to assistant messages.
	type AssistantMessageWithReasoning = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
		reasoning_details?: unknown[]
	}

	const droppedToolCallIds = new Set<string>()
	const sanitized: OpenAI.Chat.ChatCompletionMessageParam[] = []

	for (const msg of messages) {
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessageWithReasoning
			const toolCalls = assistantMsg.tool_calls
			if (Array.isArray(toolCalls) && toolCalls.length > 0) {
				const reasoningDetails = assistantMsg.reasoning_details
				const hasReasoningDetails = Array.isArray(reasoningDetails) && reasoningDetails.length > 0
				if (!hasReasoningDetails) {
					for (const tc of toolCalls) {
						if (tc?.id) {
							droppedToolCallIds.add(tc.id)
						}
					}
					if (assistantMsg.content) {
						sanitized.push({ role: "assistant", content: assistantMsg.content })
					}
					continue
				}
			}
		}

		if (msg.role === "tool") {
			if (msg.tool_call_id && droppedToolCallIds.has(msg.tool_call_id)) {
				continue
			}
		}

		sanitized.push(msg)
	}

	return sanitized
}
