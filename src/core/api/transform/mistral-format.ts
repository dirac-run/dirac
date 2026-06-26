import { Anthropic } from "@anthropic-ai/sdk"
import { DiracImageContentBlock, DiracTextContentBlock } from "@/shared/messages/content"

export type MistralMessage =
	| {
			role: "system" | "user" | "assistant"
			content: string
	  }
	| {
			role: "user"
			content: ({ type: "text"; text: string } | { type: "image_url"; imageUrl: { url: string } })[]
	  }

// Type guards narrowing Anthropic content block params to Dirac text/image blocks.
const isTextBlock = (part: Anthropic.Messages.ContentBlockParam): part is DiracTextContentBlock => part.type === "text"
const isImageBlock = (part: Anthropic.Messages.ContentBlockParam): part is DiracImageContentBlock => part.type === "image"

// Converts an image content block to a Mistral image_url block, or [Image] text if unsupported.
function convertMistralImageBlock(
	part: DiracImageContentBlock,
	supportsImages: boolean,
): { type: "image_url"; imageUrl: { url: string } } | { type: "text"; text: string } {
	if (!supportsImages) return { type: "text", text: "[Image]" }
	// source is a discriminated union (base64 | url); narrow by type to read the right field.
	const url = part.source.type === "base64" ? `data:${part.source.media_type};base64,${part.source.data}` : part.source.url
	return { type: "image_url", imageUrl: { url } }
}

// Converts user-role array content: filters to text/image blocks and maps to Mistral format.
function convertMistralUserMessage(
	content: Anthropic.Messages.ContentBlockParam[],
	supportsImages: boolean,
): MistralMessage | null {
	const textAndImageBlocks = content.filter((part) => isTextBlock(part) || isImageBlock(part))
	if (textAndImageBlocks.length === 0) return null
	return {
		role: "user",
		content: textAndImageBlocks.map((part) =>
			isImageBlock(part)
				? convertMistralImageBlock(part, supportsImages)
				: { type: "text", text: isTextBlock(part) ? part.text : "" },
		),
	}
}

// Converts assistant-role array content: joins text blocks into a single string.
function convertMistralAssistantMessage(content: Anthropic.Messages.ContentBlockParam[]): MistralMessage | null {
	const textBlocks = content.filter(isTextBlock)
	if (textBlocks.length === 0) return null
	return { role: "assistant", content: textBlocks.map((part) => part.text).join("\n") }
}

export function convertToMistralMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
	supportsImages = true,
): MistralMessage[] {
	const mistralMessages: MistralMessage[] = []

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			mistralMessages.push({ role: anthropicMessage.role, content: anthropicMessage.content })
			continue
		}
		if (anthropicMessage.role === "user") {
			const msg = convertMistralUserMessage(anthropicMessage.content, supportsImages)
			if (msg) mistralMessages.push(msg)
		} else if (anthropicMessage.role === "assistant") {
			const msg = convertMistralAssistantMessage(anthropicMessage.content)
			if (msg) mistralMessages.push(msg)
		}
	}

	return mistralMessages
}
