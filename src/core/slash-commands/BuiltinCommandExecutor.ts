import { telemetryService } from "@/services/telemetry"
import { CommandPermissionController } from "../permissions/CommandPermissionController"
import { handlePermissionsCommand } from "./PermissionsCommandHandler"
import { buildCommandReplacements, SUPPORTED_DEFAULT_COMMANDS } from "./commandRegistry"
import { removeSlashCommand } from "./commandParser"
import type { ParseSlashCommandResult, SlashCommandMatch } from "./types"

// Executes a builtin slash command; returns the result or null if not builtin.
export async function executeBuiltinCommand(
	match: SlashCommandMatch,
	fullText: string,
	ulid: string,
	permissionController: CommandPermissionController | undefined,
	extensionPath: string | undefined,
	sourceDir: string,
): Promise<ParseSlashCommandResult | null> {
	const { commandName, tagContent, contentStartIndex, slashMatch } = match
	if (!SUPPORTED_DEFAULT_COMMANDS.includes(commandName)) return null

	// /permissions delegates to the permission controller and wraps feedback as an instruction
	if (commandName === "permissions" && permissionController) {
		const { processedText: feedback } = await handlePermissionsCommand(tagContent, permissionController)
		const textWithoutSlashCommand = removeSlashCommand(fullText, contentStartIndex, slashMatch)
		const processedText =
			`<explicit_instructions type="permissions">\n${feedback}\n</explicit_instructions>\n` + textWithoutSlashCommand
		telemetryService.captureSlashCommandUsed(ulid, commandName, "builtin")
		return { processedText, needsDiracrulesFileCheck: false }
	}

	const textWithoutSlashCommand = removeSlashCommand(fullText, contentStartIndex, slashMatch)
	const replacement = buildCommandReplacements(extensionPath, sourceDir)[commandName]
	const processedText = (typeof replacement === "string" ? replacement : await replacement) + textWithoutSlashCommand
	telemetryService.captureSlashCommandUsed(ulid, commandName, "builtin")

	if (commandName === "reloadtools") {
		return {
			processedText: "",
			needsDiracrulesFileCheck: false,
			isDirectResponse: true,
			directResponseText: "__RELOAD_TOOLS__",
		}
	}
	return { processedText, needsDiracrulesFileCheck: commandName === "newrule" }
}
