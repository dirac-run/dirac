import { SLASH_COMMAND_IN_TEXT_REGEX, TAG_PATTERNS } from "./commandRegistry"
import type { SlashCommandMatch } from "./types"

// Finds the first tag containing a slash command; returns match context or null.
export function findSlashCommandInTags(text: string): SlashCommandMatch | null {
	for (const { regex } of TAG_PATTERNS) {
		const regexObj = new RegExp(regex.source, regex.flags)
		const tagMatch = regexObj.exec(text)
		if (!tagMatch) continue

		const tagContent = tagMatch[1]
		const contentStartIndex = text.indexOf(tagContent, tagMatch.index)
		const slashMatch = SLASH_COMMAND_IN_TEXT_REGEX.exec(tagContent)
		if (!slashMatch) continue

		return { commandName: slashMatch[2], tagContent, contentStartIndex, slashMatch, regexObj }
	}
	return null
}

// Removes the slash command token from the full text, preserving surrounding content.
export function removeSlashCommand(fullText: string, contentStartIndex: number, slashMatch: RegExpExecArray): string {
	const slashPositionInFullText = contentStartIndex + slashMatch.index + slashMatch[1].length
	const commandEndPosition = slashPositionInFullText + slashMatch[2].length + 1
	return fullText.substring(0, slashPositionInFullText) + fullText.substring(commandEndPosition)
}
