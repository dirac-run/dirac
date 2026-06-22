import type { ApiProviderInfo } from "@core/api"
import { getExtensionSourceDir } from "@shared/dirac/constants"
import { DiracRulesToggles } from "@shared/dirac-rules"
import { SkillMetadata } from "@/shared/skills"
import { CommandPermissionController } from "../permissions/CommandPermissionController"
import { executeBuiltinCommand } from "./BuiltinCommandExecutor"
import { findSlashCommandInTags } from "./commandParser"
import { executeSkillCommand } from "./SkillCommandExecutor"
import type { ParseSlashCommandResult } from "./types"
import { collectEnabledWorkflows, executeWorkflowCommand } from "./WorkflowCommandExecutor"

export type { ParseSlashCommandResult } from "./types"

/**
 * Parses text for slash commands and transforms them with appropriate instructions.
 * Called after parseMentions() to process any slash commands in the user's message.
 *
 * Precedence: builtin commands > local workflows > global workflows > remote workflows > skills.
 */
export async function parseSlashCommands(
	text: string,
	localWorkflowToggles: DiracRulesToggles,
	globalWorkflowToggles: DiracRulesToggles,
	ulid: string,
	providerInfo?: ApiProviderInfo,
	availableSkills: SkillMetadata[] = [],
	permissionController?: CommandPermissionController,
	extensionPath?: string,
	sourceDir: string = getExtensionSourceDir(),
): Promise<ParseSlashCommandResult> {
	const match = findSlashCommandInTags(text)
	if (!match) return { processedText: text, needsDiracrulesFileCheck: false }

	const builtinResult = await executeBuiltinCommand(match, text, ulid, permissionController, extensionPath, sourceDir)
	if (builtinResult) return builtinResult

	const enabledWorkflows = collectEnabledWorkflows(localWorkflowToggles, globalWorkflowToggles)
	const workflowResult = await executeWorkflowCommand(match, text, ulid, enabledWorkflows)
	if (workflowResult) return workflowResult

	const skillResult = await executeSkillCommand(match, text, ulid, availableSkills)
	if (skillResult) return skillResult

	// No supported command, workflow, or skill matched — return the original text unchanged
	return { processedText: text, needsDiracrulesFileCheck: false }
}
