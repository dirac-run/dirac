import { synchronizeRuleToggles } from "@core/context/instructions/user-instructions/rule-helpers"
import { ensureWorkflowsDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import { StateManager } from "@core/storage/StateManager"
import { DiracRulesToggles } from "@shared/dirac-rules"
import path from "path"

/**
 * Refresh the workflow toggles
 */
export async function refreshWorkflowToggles(
	stateManager: StateManager,
	workingDirectory: string,
): Promise<{
	globalWorkflowToggles: DiracRulesToggles
	localWorkflowToggles: DiracRulesToggles
}> {
	// Global workflows
	const globalWorkflowToggles = stateManager.getGlobalSettingsKey("globalWorkflowToggles")
	const globalDiracWorkflowsFilePath = await ensureWorkflowsDirectoryExists()
	const updatedGlobalWorkflowToggles = await synchronizeRuleToggles(globalDiracWorkflowsFilePath, globalWorkflowToggles)
	stateManager.setGlobalState("globalWorkflowToggles", updatedGlobalWorkflowToggles)

	const workflowRulesToggles = stateManager.getWorkspaceStateKey("workflowToggles")
	const workflowsDirPath = path.resolve(workingDirectory, GlobalFileNames.workflows)
	const updatedWorkflowToggles = await synchronizeRuleToggles(workflowsDirPath, workflowRulesToggles)
	stateManager.setWorkspaceState("workflowToggles", updatedWorkflowToggles)

	return {
		globalWorkflowToggles: updatedGlobalWorkflowToggles,
		localWorkflowToggles: updatedWorkflowToggles,
	}
}
