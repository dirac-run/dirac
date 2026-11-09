import { createHash } from "node:crypto";
import { Anthropic } from "@anthropic-ai/sdk";
import { DiracImageContentBlock, DiracTextContentBlock, DiracUserToolResultContentBlock } from "@/shared/messages/content";

export type MistralContentBlock = { type: "text"; text: string } | { type: "image_url"; imageUrl: { url: string } }

type MistralAssistantContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: { type: "text"; text: string }[]; closed: true }

interface MistralToolCall {
	id: string
	type: "function"
	index: number
	function: {
		name: string
		arguments: string
	}
}

export type MistralMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | MistralContentBlock[] }
	| { role: "assistant"; content: string | MistralAssistantContentBlock[] | null; toolCalls?: MistralToolCall[] }
	| { role: "tool"; content: MistralContentBlock[]; toolCallId: string; name?: string }

const MISTRAL_TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9]{9}$/

const isTextBlock = (part: unknown): part is DiracTextContentBlock => (part as DiracTextContentBlock).type === "text"
const isImageBlock = (part: unknown): part is DiracImageContentBlock => (part as DiracImageContentBlock).type === "image"

function hashMistralToolCallId(originalId: string, collisionIndex: number): string {
	return createHash("sha256").update(`${originalId}:${collisionIndex}`).digest("hex").slice(0, 9)
}

function createMistralToolCallIdMap(messages: Anthropic.Messages.MessageParam[]): Map<string, string> {
	const originalIds = new Set<string>()
	for (const message of messages) {
		if (typeof message.content === "string") continue
		for (const block of message.content) {
			if (block.type === "tool_use") originalIds.add(block.id)
			if (block.type === "tool_result") originalIds.add(block.tool_use_id)
		}
	}

	const mappedIds = new Map<string, string>()
	const usedIds = new Map<string, string>()
	for (const originalId of originalIds) {
		if (!MISTRAL_TOOL_CALL_ID_PATTERN.test(originalId)) continue
		mappedIds.set(originalId, originalId)
		usedIds.set(originalId, originalId)
	}

	for (const originalId of originalIds) {
		if (mappedIds.has(originalId)) continue

		let collisionIndex = 0
		let mappedId = hashMistralToolCallId(originalId, collisionIndex)
		while (usedIds.has(mappedId)) {
			collisionIndex++
			mappedId = hashMistralToolCallId(originalId, collisionIndex)
		}

		mappedIds.set(originalId, mappedId)
		usedIds.set(mappedId, originalId)
	}
	return mappedIds
}

function convertMistralImageBlock(part: DiracImageContentBlock, supportsImages: boolean): MistralContentBlock {
	if (!supportsImages) return { type: "text", text: "[Image]" }
	const url = part.source.type === "base64" ? `data:${part.source.media_type};base64,${part.source.data}` : part.source.url
	return { type: "image_url", imageUrl: { url } }
}

function convertMistralToolResultContent(part: DiracUserToolResultContentBlock, supportsImages: boolean): MistralContentBlock[] {
	if (typeof part.content === "string") return [{ type: "text", text: part.content }]
	if (!Array.isArray(part.content)) return [{ type: "text", text: "[Empty tool result]" }]

	const content = part.content.flatMap((contentBlock): MistralContentBlock[] => {
		if (isTextBlock(contentBlock)) return [{ type: "text", text: contentBlock.text }]
		if (isImageBlock(contentBlock)) return [convertMistralImageBlock(contentBlock, supportsImages)]
		return []
	})
	return content.length > 0 ? content : [{ type: "text", text: "[Empty tool result]" }]
}

function convertMistralUserMessages(
	content: Anthropic.Messages.ContentBlockParam[],
	toolUseIdToName: Map<string, string>,
	toolCallIds: Map<string, string>,
	supportsImages: boolean,
): MistralMessage[] {
	const toolResults: MistralMessage[] = []
	const userContent: MistralContentBlock[] = []

	for (const part of content) {
		if (part.type === "tool_result") {
			toolResults.push({
				role: "tool",
				toolCallId: toolCallIds.get(part.tool_use_id)!,
				name: toolUseIdToName.get(part.tool_use_id),
				content: convertMistralToolResultContent(part as DiracUserToolResultContentBlock, supportsImages),
			})
			continue
		}
		if (isTextBlock(part)) userContent.push({ type: "text", text: part.text })
		else if (isImageBlock(part)) userContent.push(convertMistralImageBlock(part, supportsImages))
	}

	if (userContent.length > 0) toolResults.push({ role: "user", content: userContent })
	return toolResults
}

function convertMistralAssistantMessage(
	content: Anthropic.Messages.ContentBlockParam[],
	toolCallIds: Map<string, string>,
	includeReasoning: boolean,
): MistralMessage | null {
	const text = content
		.filter(isTextBlock)
		.map((part) => part.text)
		.join("\n")
	const toolCalls = content
		.filter((part): part is Anthropic.Messages.ToolUseBlockParam => part.type === "tool_use")
		.map((part, index) => ({
			id: toolCallIds.get(part.id)!,
			index,
			type: "function" as const,
			function: {
				name: part.name,
				arguments: JSON.stringify(part.input),
			},
		}))
	const reasoningContent = includeReasoning
		? content.flatMap((part): MistralAssistantContentBlock[] => {
			if (part.type === "thinking") {
				return [{ type: "thinking", thinking: [{ type: "text", text: part.thinking }], closed: true }]
			}
			if (isTextBlock(part)) return [{ type: "text", text: part.text }]
			return []
		})
		: []
	const hasReasoning = reasoningContent.some((part) => part.type === "thinking")
	if (!text && !hasReasoning && toolCalls.length === 0) return null
	return {
		role: "assistant",
		content: hasReasoning ? reasoningContent : text || null,
		...(toolCalls.length > 0 ? { toolCalls } : {}),
	}
}

export function convertToMistralMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
	supportsImages = true,
	includeReasoning = false,
): MistralMessage[] {
	const toolUseIdToName = new Map<string, string>()
	for (const message of anthropicMessages) {
		if (typeof message.content === "string") continue
		for (const block of message.content) {
			if (block.type === "tool_use") toolUseIdToName.set(block.id, block.name)
		}
	}
	const toolCallIds = createMistralToolCallIdMap(anthropicMessages)

	const mistralMessages: MistralMessage[] = []
	for (const message of anthropicMessages) {
		if (typeof message.content === "string") {
			mistralMessages.push({ role: message.role, content: message.content })
			continue
		}
		if (message.role === "user") {
			mistralMessages.push(...convertMistralUserMessages(message.content, toolUseIdToName, toolCallIds, supportsImages))
			continue
		}

		const converted = convertMistralAssistantMessage(message.content, toolCallIds, includeReasoning)
		if (converted) mistralMessages.push(converted)
	}
	return mistralMessages
}
