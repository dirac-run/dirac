import { AssistantMessageContent } from "."

/**
 * Parses an assistant message string into content blocks.
 * Supports `<thinking>` and `<think>` tags for reasoning blocks.
 * Assumes native tool calling, so no XML tool call parsing is performed.
 *
 * @param assistantMessage The raw string output from the assistant.
 * @returns An array of `AssistantMessageContent` objects, which can be `TextContent` or `ReasoningContent`.
 */
export function parseAssistantMessageV2(assistantMessage: string, isStreamActive: boolean = false): AssistantMessageContent[] {
	const contentBlocks: AssistantMessageContent[] = []
	let i = 0
	const len = assistantMessage.length

	while (i < len) {
		const remaining = assistantMessage.slice(i)

		// Check for reasoning tags
		const openingTagMatch = remaining.match(/^<(thinking|think)>/i)
		if (openingTagMatch) {
			const tagName = openingTagMatch[1]
			const openingTag = openingTagMatch[0]
			const closingTag = `</${tagName}>`

			const closingTagIndex = remaining.toLowerCase().indexOf(closingTag.toLowerCase(), openingTag.length)

			if (closingTagIndex !== -1) {
				// Found complete reasoning block
				const content = remaining.slice(openingTag.length, closingTagIndex).trim()
				if (content) {
					contentBlocks.push({
						type: "reasoning",
						reasoning: content,
						isComplete: true,
					})
				}
				i += closingTagIndex + closingTag.length
				continue
			}
			// Partial reasoning block (tag not closed)
			let content = remaining.slice(openingTag.length)
			const partialCloseMatch = content.match(/<\/(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/i)
			if (partialCloseMatch) {
				content = content.slice(0, partialCloseMatch.index)
			}
			content = content.trim()
			if (content) {
				contentBlocks.push({
					type: "reasoning",
					reasoning: content,
				})
			}
			i = len // Done
			continue
		}

		// It's a text block or we're looking for the next reasoning tag
		const nextTagMatch = remaining.match(/<(thinking|think)>/i)
		if (nextTagMatch && nextTagMatch.index !== undefined && nextTagMatch.index > 0) {
			// Found a tag later in the string, finalize text until then
			const text = remaining.slice(0, nextTagMatch.index).trim()
			if (text) {
				contentBlocks.push({
					type: "text",
					content: text,
					isComplete: true,
				})
			}
			i += nextTagMatch.index
		} else if (!nextTagMatch) {
			// Check for partial opening tag at the end of the string
			const partialTagMatch = remaining.match(/<t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?$/i)
			
			if (partialTagMatch && partialTagMatch.index !== undefined) {
				const text = isStreamActive ? remaining.slice(0, partialTagMatch.index) : remaining.slice(0, partialTagMatch.index).trim()
				if (text) {
					contentBlocks.push({
						type: "text",
						content: text,
					})
				}
			} else {
				// No more tags, finalize remaining as text
				const text = isStreamActive ? remaining : remaining.trim()
				if (text) {
					contentBlocks.push({
						type: "text",
						content: text,
					})
				}
			}
			i = len
		} else if (nextTagMatch.index === 0) {
			// Should have been handled by the openingTagMatch above, but just in case
			// If it's a tag we don't recognize or malformed, treat as text
			const text = remaining[0]
			if (contentBlocks.length > 0 && contentBlocks[contentBlocks.length - 1].type === "text") {
				;(contentBlocks[contentBlocks.length - 1] as any).content += text
			} else {
				contentBlocks.push({
					type: "text",
					content: text,
				})
			}
			i++
		}
	}

	return contentBlocks
}
