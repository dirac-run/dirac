import fs from "fs/promises"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { DiracRulesToggles } from "@shared/dirac-rules"
import { removeSlashCommand } from "./commandParser"
import { StateManager } from "../storage/StateManager"
import type { ParseSlashCommandResult, SlashCommandMatch, Workflow } from "./types"

// Converts a toggles map (filepath -> enabled) into a list of file-based workflows.
function togglesToWorkflows(toggles: DiracRulesToggles): Workflow[] {
	return Object.entries(toggles)
		.filter(([, enabled]) => enabled)
		.map(([filePath]) => ({ fullPath: filePath, fileName: filePath.replace(/^.*[/\\]/, ""), isRemote: false }))
}

// Collects remote workflows from StateManager, respecting alwaysEnabled and toggles.
function collectRemoteWorkflows(): Workflow[] {
	const remoteWorkflowToggles = StateManager.get().getGlobalStateKey("remoteWorkflowToggles") || {}
	const remoteWorkflows: any[] = []
	return remoteWorkflows
		.filter((wf) => wf.alwaysEnabled || remoteWorkflowToggles[wf.name] !== false)
		.map((wf) => ({ fullPath: "", fileName: wf.name, isRemote: true, contents: wf.contents }))
}

// Builds the full enabled-workflow list with precedence: local > global > remote.
export function collectEnabledWorkflows(localToggles: DiracRulesToggles, globalToggles: DiracRulesToggles): Workflow[] {
	return [...togglesToWorkflows(localToggles), ...togglesToWorkflows(globalToggles), ...collectRemoteWorkflows()]
}

// Matches a workflow by command name and injects its content; returns null on no match or read error.
export async function executeWorkflowCommand(
	match: SlashCommandMatch,
	fullText: string,
	ulid: string,
	enabledWorkflows: Workflow[],
): Promise<ParseSlashCommandResult | null> {
	const { commandName, contentStartIndex, slashMatch } = match
	const workflow = enabledWorkflows.find((wf) => wf.fileName === commandName)
	if (!workflow) return null

	try {
		const workflowContent = workflow.isRemote
			? workflow.contents.trim()
			: (await fs.readFile(workflow.fullPath, "utf8")).trim()
		const textWithoutSlashCommand = removeSlashCommand(fullText, contentStartIndex, slashMatch)
		const processedText =
			`<explicit_instructions type="${workflow.fileName}">\n${workflowContent}\n</explicit_instructions>\n` +
			textWithoutSlashCommand
		telemetryService.captureSlashCommandUsed(ulid, commandName, "workflow")
		return { processedText, needsDiracrulesFileCheck: false }
	} catch (error) {
		Logger.error(`Error reading workflow file ${workflow.fullPath}: ${error}`)
		return null
	}
}
