import { mentionRegexGlobal } from "@shared/context-mentions"
import { slashCommandRegexGlobal } from "@/shared/lib/slash-commands"
import { InputDecorator, ModularInputContext } from "../types"

export const HighlightDecorator: InputDecorator = {
	id: "highlight",
	renderHighlight: (value: string, context: ModularInputContext) => {
		let processedText = value.replace(/\n$/, "\n\n").replace(/[<>&]/g, (c) => ({ "<": "<", ">": ">", "&": "&" })[c] || c)

		// Highlight @mentions
		processedText = processedText.replace(mentionRegexGlobal, '<mark class="mention-context-textarea-highlight">$&</mark>')

		// Highlight only the FIRST valid /slash-command in the text
		slashCommandRegexGlobal.lastIndex = 0
		let hasHighlightedSlashCommand = false
		processedText = processedText.replace(slashCommandRegexGlobal, (match, prefix, command) => {
			if (hasHighlightedSlashCommand) {
				return match
			}

			const commandName = command.substring(1)
			// For now, we'll assume it's valid if it matches the regex
			// In a real implementation, we would check against available skills/workflows
			const isValidCommand = true

			if (isValidCommand) {
				hasHighlightedSlashCommand = true
				return `${prefix}<mark class="mention-context-textarea-highlight">${command}</mark>`
			}
			return match
		})

		return <div dangerouslySetInnerHTML={{ __html: processedText }} />
	},
}
