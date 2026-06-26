import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { DiracAssistantThinkingBlock, DiracStorageMessage } from "@/shared/messages/content"

/**
 * DeepSeek Reasoner message format with reasoning_content support.
 */
export type DeepSeekReasonerMessage =
	| OpenAI.Chat.ChatCompletionSystemMessageParam
	| OpenAI.Chat.ChatCompletionUserMessageParam
	| (OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning_content?: string })
	| OpenAI.Chat.ChatCompletionToolMessageParam
	| OpenAI.Chat.ChatCompletionFunctionMessageParam

export function addReasoningContent(
	openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
	originalMessages: DiracStorageMessage[],
	options?: { onlyIfToolCall?: boolean },
): DeepSeekReasonerMessage[] {
	// Extract thinking content from original messages, keyed by assistant index
	const thinkingByIndex = new Map<number, { thinking: string; hasToolCall: boolean }>()
	let assistantIdx = 0
	for (const msg of originalMessages) {
		if (msg.role === "assistant") {
			let thinking = ""
			let hasToolCall = false
			if (Array.isArray(msg.content)) {
				thinking = msg.content
					.filter((p): p is DiracAssistantThinkingBlock => p.type === "thinking")
					.map((p) => p.thinking)
					.join("\n")
				hasToolCall = msg.content.some((p) => p.type === "tool_use")
			}
			// Always record an entry for every assistant message to ensure we can add reasoning_content field
			thinkingByIndex.set(assistantIdx, { thinking, hasToolCall })
			assistantIdx++
		}
	}

	// Add reasoning_content to assistant messages
	let aiIdx = 0
	return openAiMessages.map((msg): DeepSeekReasonerMessage => {
		if (msg.role === "assistant") {
			const data = thinkingByIndex.get(aiIdx++)
			if (data) {
				const shouldInclude = options?.onlyIfToolCall ? data.hasToolCall : true
				if (shouldInclude) {
					return { ...msg, reasoning_content: data.thinking } as DeepSeekReasonerMessage
				}
			}
			// If we are in R1 format, we should always include reasoning_content even if empty
			return { ...msg, reasoning_content: "" } as DeepSeekReasonerMessage
		}
		return msg as DeepSeekReasonerMessage
	})
}

// Type guard for Anthropic thinking blocks within content block params.
const isThinkingBlock = (part: Anthropic.Messages.ContentBlockParam): part is Anthropic.ThinkingBlockParam =>
	part.type === "thinking"

// Converts an Anthropic message part array into R1 content (text, images, thinking).
function convertR1Content(
	content: Anthropic.Messages.ContentBlockParam[],
	supportsImages: boolean,
): {
	messageContent: string | (OpenAI.Chat.ChatCompletionContentPartText | OpenAI.Chat.ChatCompletionContentPartImage)[]
	thinking: string
} {
	const textParts: string[] = []
	const imageParts: OpenAI.Chat.ChatCompletionContentPartImage[] = []
	let thinking = ""

	content.forEach((part) => {
		if (part.type === "text") textParts.push(part.text || "")
		if (part.type === "image") {
			if (supportsImages) {
				imageParts.push({
					type: "image_url",
					image_url: {
						url:
							part.source.type === "base64"
								? `data:${part.source.media_type};base64,${part.source.data}`
								: part.source.url,
					},
				})
			} else {
				textParts.push("[Image]")
			}
		}
		if (isThinkingBlock(part)) thinking += (thinking ? "\n" : "") + (part.thinking || "")
	})

	if (imageParts.length > 0) {
		const parts: (OpenAI.Chat.ChatCompletionContentPartText | OpenAI.Chat.ChatCompletionContentPartImage)[] = []
		if (textParts.length > 0) parts.push({ type: "text", text: textParts.join("\n") })
		parts.push(...imageParts)
		return { messageContent: parts, thinking }
	}
	return { messageContent: textParts.join("\n"), thinking }
}

// Merges same-role consecutive messages by appending content.
function mergeR1Message(lastMessage: any, messageContent: any, thinking: string, role: string) {
	if (typeof lastMessage.content === "string" && typeof messageContent === "string") {
		lastMessage.content += `\n${messageContent}`
		return
	}
	const lastContent = Array.isArray(lastMessage.content)
		? lastMessage.content
		: [{ type: "text" as const, text: lastMessage.content || "" }]
	const newContent = Array.isArray(messageContent) ? messageContent : [{ type: "text" as const, text: messageContent }]
	if (role === "assistant") {
		lastMessage.content = [...lastContent, ...newContent]
		if (thinking) {
			const current = lastMessage.reasoning_content || ""
			lastMessage.reasoning_content = current + (current ? "\n" : "") + thinking
		}
	} else {
		lastMessage.content = [...lastContent, ...newContent]
	}
}

export function convertToR1Format(
	messages: Anthropic.Messages.MessageParam[],
	supportsImages = false,
): DeepSeekReasonerMessage[] {
	return messages.reduce<DeepSeekReasonerMessage[]>((merged, message) => {
		const lastMessage = merged[merged.length - 1]
		let messageContent: string | (OpenAI.Chat.ChatCompletionContentPartText | OpenAI.Chat.ChatCompletionContentPartImage)[] =
			""
		let thinking = ""

		if (Array.isArray(message.content)) {
			const result = convertR1Content(message.content, supportsImages)
			messageContent = result.messageContent
			thinking = result.thinking
		} else {
			messageContent = message.content
		}

		if (lastMessage?.role === message.role) {
			mergeR1Message(lastMessage, messageContent, thinking, message.role)
		} else if (message.role === "assistant") {
			merged.push({
				role: "assistant",
				content: messageContent as OpenAI.Chat.ChatCompletionAssistantMessageParam["content"],
				reasoning_content: thinking || "",
			})
		} else {
			merged.push({ role: "user", content: messageContent })
		}
		return merged
	}, [])
}
