// Formats assistant response content for display — sanitizes model quirks
// (stray XML tags, function_calls wrappers) and trims unclosed code fences.
export class ResponseFormatter {
	// Remove <function_calls> wrappers and trim incomplete XML tags from streaming content
	sanitizeModelQuirks(content: string): string {
		content = content.replace(/<function_calls>\s?/g, "")
		content = content.replace(/\s?<\/function_calls>/g, "")
		return this.trimIncompleteTag(content)
	}

	// Trim trailing unclosed code fence (e.g. ```python) from complete text blocks
	trimTrailingCodeFence(content: string): string {
		const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
		if (!match) return content
		return content.trimEnd().slice(0, -match[0].length)
	}

	// Trim incomplete opening/closing tag at end of content (e.g. "<func" or "</func")
	private trimIncompleteTag(content: string): string {
		const lastOpenBracketIndex = content.lastIndexOf("<")
		if (lastOpenBracketIndex === -1) return content
		const possibleTag = content.slice(lastOpenBracketIndex)
		if (possibleTag.includes(">")) return content // complete tag, keep
		const tagContent = possibleTag.startsWith("</") ? possibleTag.slice(2).trim() : possibleTag.slice(1).trim()
		const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
		const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
		if (isOpeningOrClosing || isLikelyTagName) return content.slice(0, lastOpenBracketIndex).trim()
		return content
	}
}
