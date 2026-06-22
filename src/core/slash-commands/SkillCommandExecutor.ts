import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { SkillMetadata } from "@/shared/skills"
import { getSkillContent } from "../context/instructions/user-instructions/skills"
import { removeSlashCommand } from "./commandParser"
import type { ParseSlashCommandResult, SlashCommandMatch } from "./types"

// Matches a skill by command name and injects its instructions; returns null on no match or error.
export async function executeSkillCommand(
	match: SlashCommandMatch,
	fullText: string,
	ulid: string,
	availableSkills: SkillMetadata[],
): Promise<ParseSlashCommandResult | null> {
	const { commandName, contentStartIndex, slashMatch, regexObj } = match
	const skill = availableSkills.find((s) => s.name === commandName)
	if (!skill) return null

	try {
		const skillContent = await getSkillContent(skill.name, availableSkills)
		if (!skillContent) return null

		const textWithoutSlashCommand = removeSlashCommand(fullText, contentStartIndex, slashMatch)
		let processedText = `<explicit_instructions type="skill" name="${skillContent.name}">\n${skillContent.instructions}\n</explicit_instructions>\n`

		// If the tag is now empty, add a note so the agent acknowledges skill activation
		const newTagContentMatch = regexObj.exec(textWithoutSlashCommand)
		const newTagContent = newTagContentMatch ? newTagContentMatch[1].trim() : ""
		if (!newTagContent) {
			processedText += `\n(Note: The user has explicitly activated the "${skillContent.name}" skill via a slash command. This skill is now active. Please acknowledge its activation, summarize how you can help based on its instructions, and ask the user for the specific target or task they want you to perform, or propose a first step if appropriate.)\n`
		}

		processedText += textWithoutSlashCommand
		telemetryService.captureSlashCommandUsed(ulid, commandName, "skill")
		return { processedText, needsDiracrulesFileCheck: false }
	} catch (error) {
		Logger.error(`Error loading skill ${skill.name}: ${error}`)
		return null
	}
}
