import { resolveWorkspacePath } from "@core/workspace"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { DiracDefaultTool } from "@shared/tools"
import { CommandPermissionController } from "@/core/permissions/CommandPermissionController"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { getCwd, getDesktopDir, isLocatedInPath, isLocatedInWorkspace } from "@/utils/path"


const WRITE_TOOLS: DiracDefaultTool[] = [
	DiracDefaultTool.FILE_NEW,
	DiracDefaultTool.EDIT_FILE,
	DiracDefaultTool.REPLACE_SYMBOL,
	DiracDefaultTool.RENAME_SYMBOL,
	DiracDefaultTool.NEW_RULE,
]

export class AutoApprove {
	private stateManager: StateManager
	private commandPermissionController: CommandPermissionController
	// Cache for workspace paths - populated on first access and reused for the task lifetime
	// NOTE: This assumes that the task has a fixed set of workspace roots(which is currently true).
	private workspacePathsCache: { paths: string[] } | null = null
	private isMultiRootScenarioCache: boolean | null = null

	constructor(stateManager: StateManager, commandPermissionController: CommandPermissionController) {
		this.stateManager = stateManager
		this.commandPermissionController = commandPermissionController
	}

	/**
	 * Get workspace information with caching to avoid repeated API calls
	 * Cache is task-scoped since each task gets a new AutoApprove instance
	 */
	private async getWorkspaceInfo(): Promise<{
		workspacePaths: { paths: string[] }
		isMultiRootScenario: boolean
	}> {
		// Check if we already have cached values
		if (this.workspacePathsCache === null || this.isMultiRootScenarioCache === null) {
			// First time - fetch and cache for the lifetime of this task
			this.workspacePathsCache = await HostProvider.workspace.getWorkspacePaths({})
			this.isMultiRootScenarioCache = isMultiRootEnabled(this.stateManager) && this.workspacePathsCache.paths.length > 1
		}

		return {
			workspacePaths: this.workspacePathsCache,
			isMultiRootScenario: this.isMultiRootScenarioCache,
		}
	}

		// Check if the tool should be auto-approved based on the settings
	// Returns bool for most tools, and tuple for tools with nested settings
	shouldAutoApproveTool(toolName: DiracDefaultTool): boolean | [boolean, boolean] {
		if (this.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
			switch (toolName) {
				case DiracDefaultTool.FILE_READ:
				case DiracDefaultTool.GET_FUNCTION:
				case DiracDefaultTool.GET_FILE_SKELETON:
				case DiracDefaultTool.FIND_SYMBOL_REFERENCES:
				case DiracDefaultTool.DIAGNOSTICS_SCAN:
				case DiracDefaultTool.LIST_FILES:
				case DiracDefaultTool.SEARCH:
				case DiracDefaultTool.NEW_RULE:
				case DiracDefaultTool.FILE_NEW:
				case DiracDefaultTool.EDIT_FILE:
				case DiracDefaultTool.REPLACE_SYMBOL:
				case DiracDefaultTool.USE_SUBAGENTS:
				case DiracDefaultTool.USE_SKILL:
					return [true, true]

				case DiracDefaultTool.BASH:
				case DiracDefaultTool.BROWSER:
					return true
			}
		}

		if (this.stateManager.getGlobalSettingsKey("autoApproveAllToggled")) {
			switch (toolName) {
				case DiracDefaultTool.FILE_READ:
				case DiracDefaultTool.GET_FUNCTION:
				case DiracDefaultTool.GET_FILE_SKELETON:
				case DiracDefaultTool.FIND_SYMBOL_REFERENCES:
				case DiracDefaultTool.DIAGNOSTICS_SCAN:
				case DiracDefaultTool.LIST_FILES:
				case DiracDefaultTool.SEARCH:
				case DiracDefaultTool.NEW_RULE:
				case DiracDefaultTool.FILE_NEW:
				case DiracDefaultTool.EDIT_FILE:
				case DiracDefaultTool.REPLACE_SYMBOL:
				case DiracDefaultTool.USE_SUBAGENTS:
				case DiracDefaultTool.USE_SKILL:
					return [true, true]

				case DiracDefaultTool.BASH:
				case DiracDefaultTool.BROWSER:
					return true
			}
		}

		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")

		switch (toolName) {
			case DiracDefaultTool.FILE_READ:
			case DiracDefaultTool.GET_FUNCTION:
			case DiracDefaultTool.GET_FILE_SKELETON:
			case DiracDefaultTool.FIND_SYMBOL_REFERENCES:
			case DiracDefaultTool.DIAGNOSTICS_SCAN:
			case DiracDefaultTool.LIST_FILES:
			case DiracDefaultTool.SEARCH:
			case DiracDefaultTool.USE_SUBAGENTS:
			case DiracDefaultTool.USE_SKILL:
				return [autoApprovalSettings.actions.readFiles, autoApprovalSettings.actions.readFilesExternally ?? false]

			case DiracDefaultTool.NEW_RULE:
			case DiracDefaultTool.FILE_NEW:
			case DiracDefaultTool.EDIT_FILE:
			case DiracDefaultTool.REPLACE_SYMBOL:
				return [autoApprovalSettings.actions.editFiles, autoApprovalSettings.actions.editFilesExternally ?? false]

			case DiracDefaultTool.BASH:
				return autoApprovalSettings.actions.executeCommands ?? false
			case DiracDefaultTool.BROWSER:
				return autoApprovalSettings.actions.useBrowser
		}
		return false
	}

	// Check if the tool should be auto-approved based on the settings
	// and the path of the action. Returns true if the tool should be auto-approved
	// based on the user's settings and the path of the action.
	async shouldAutoApproveToolWithPath(
		blockname: DiracDefaultTool,
		autoApproveActionpath: string | undefined,
	): Promise<boolean> {
		// 1. Determine if the action is local or external FIRST
		let isLocalRead = false
		if (autoApproveActionpath) {
			// Use cached workspace info instead of fetching every time
			const { isMultiRootScenario } = await this.getWorkspaceInfo()

			if (isMultiRootScenario) {
				// Multi-root: check if file is in ANY workspace
				isLocalRead = await isLocatedInWorkspace(autoApproveActionpath)
			} else {
				// Single-root: use existing logic
				const cwd = await getCwd(getDesktopDir())
				// When called with a string cwd, resolveWorkspacePath returns a string
				const absolutePath = resolveWorkspacePath(
					cwd,
					autoApproveActionpath,
					"AutoApprove.shouldAutoApproveToolWithPath",
				) as string
				isLocalRead = isLocatedInPath(cwd, absolutePath)
			}
		} else {
			// If we do not get a path for some reason, default to a (safer) false return
			isLocalRead = false
		}

		// 2. SAFETY POLICY: Always require manual approval for writes outside the workspace, even in YOLO mode
		const isWriteOperation = WRITE_TOOLS.includes(blockname)
		if (!isLocalRead && isWriteOperation) {
			return false
		}

		if (this.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
			return true
		}
		if (this.stateManager.getGlobalSettingsKey("autoApproveAllToggled")) {
			return true
		}
		// Get auto-approve settings for local and external edits
		const autoApproveResult = this.shouldAutoApproveTool(blockname)
		const [autoApproveLocal, autoApproveExternal] = Array.isArray(autoApproveResult)
			? autoApproveResult
			: [autoApproveResult, false]

		// 3. Check permission rules
		if (this.shouldAutoApproveWithRules(blockname, autoApproveActionpath)) {
			return true
		}


		if ((isLocalRead && autoApproveLocal) || (!isLocalRead && autoApproveLocal && autoApproveExternal)) {
			return true
		}
		return false
	}

	/**
	 * Check if the tool should be auto-approved based on the permission rules.
	 */
	public shouldAutoApproveWithRules(toolName: DiracDefaultTool, path?: string): boolean {
		const result = this.commandPermissionController.validateTool(toolName, path)
		return result.allowed && result.reason === "allowed"
	}

}

