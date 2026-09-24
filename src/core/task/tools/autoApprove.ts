import { resolveWorkspacePath } from "@core/workspace"
import type { Settings } from "@shared/storage/state-keys"
import { DiracDefaultTool } from "@shared/tools"
import { CommandPermissionController } from "@/core/permissions/CommandPermissionController"
import { HostProvider } from "@/hosts/host-provider"
import { getCwd, getDesktopDir, isLocatedInPath, isLocatedInWorkspace } from "@/utils/path"
import type { DeepReadonly } from "../runtime/TaskWorkingConfiguration"
import { isSafeCommand } from "./utils/CommandSafetyChecker"
import { areCommandSegmentsApproved, isUserApprovedCommandSegment } from "./utils/UserApprovedCommandMatcher"

const WRITE_TOOLS: DiracDefaultTool[] = [DiracDefaultTool.FILE_NEW, DiracDefaultTool.EDIT_FILE, DiracDefaultTool.EDIT_AST]

export type ToolPermissionDisposition = "auto_approve" | "utility_eligible" | "manual_only"

export class AutoApprove {
	private commandPermissionController: CommandPermissionController
	// Cache for workspace paths - populated on first access and reused for the task lifetime
	// NOTE: This assumes that the task has a fixed set of workspace roots(which is currently true).
	private workspacePathsCache: { paths: string[] } | null = null
	private isMultiRootScenarioCache: boolean | null = null

	constructor(
		commandPermissionController: CommandPermissionController,
		private readonly settingsSource: DeepReadonly<Settings> | (() => DeepReadonly<Settings>),
		private readonly multiRootEnabled: boolean,
	) {
		this.commandPermissionController = commandPermissionController
	}

	private setting<K extends keyof Settings>(key: K): DeepReadonly<Settings[K]> {
		const settings = typeof this.settingsSource === "function" ? this.settingsSource() : this.settingsSource
		return settings[key]
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
			this.isMultiRootScenarioCache = this.multiRootEnabled && this.workspacePathsCache.paths.length > 1
		}

		return {
			workspacePaths: this.workspacePathsCache,
			isMultiRootScenario: this.isMultiRootScenarioCache,
		}
	}

	// Check if the tool should be auto-approved based on the settings
	// Returns bool for most tools, and tuple for tools with nested settings
	shouldAutoApproveTool(toolName: DiracDefaultTool): boolean | [boolean, boolean] {
		if (this.setting("yoloModeToggled")) {
			switch (toolName) {
				case DiracDefaultTool.FILE_READ:
				case DiracDefaultTool.INSPECT_AST:
				case DiracDefaultTool.DIAGNOSTICS_SCAN:
				case DiracDefaultTool.LIST_FILES:
				case DiracDefaultTool.SEARCH:
				case DiracDefaultTool.FILE_NEW:
				case DiracDefaultTool.EDIT_FILE:
				case DiracDefaultTool.EDIT_AST:
				case DiracDefaultTool.USE_SUBAGENTS:
				case DiracDefaultTool.USE_SKILL:
					return [true, true]

				case DiracDefaultTool.EXECUTE_COMMAND:
				case DiracDefaultTool.BROWSER:
					return true
				default:
					return true
			}
		}

		if (this.setting("autoApproveAllToggled")) {
			switch (toolName) {
				case DiracDefaultTool.FILE_READ:
				case DiracDefaultTool.INSPECT_AST:
				case DiracDefaultTool.DIAGNOSTICS_SCAN:
				case DiracDefaultTool.LIST_FILES:
				case DiracDefaultTool.SEARCH:
				case DiracDefaultTool.FILE_NEW:
				case DiracDefaultTool.EDIT_FILE:
				case DiracDefaultTool.EDIT_AST:
				case DiracDefaultTool.USE_SUBAGENTS:
				case DiracDefaultTool.USE_SKILL:
					return [true, true]

				case DiracDefaultTool.EXECUTE_COMMAND:
				case DiracDefaultTool.BROWSER:
					return true
			}
		}

		const autoApprovalSettings = this.setting("autoApprovalSettings")

		switch (toolName) {
			case DiracDefaultTool.FILE_READ:
			case DiracDefaultTool.INSPECT_AST:
			case DiracDefaultTool.DIAGNOSTICS_SCAN:
			case DiracDefaultTool.LIST_FILES:
			case DiracDefaultTool.SEARCH:
			case DiracDefaultTool.USE_SUBAGENTS:
			case DiracDefaultTool.USE_SKILL:
				return [autoApprovalSettings.actions.readFiles, autoApprovalSettings.actions.readFilesExternally ?? false]

			case DiracDefaultTool.FILE_NEW:
			case DiracDefaultTool.EDIT_FILE:
			case DiracDefaultTool.EDIT_AST:
				return [autoApprovalSettings.actions.editFiles, autoApprovalSettings.actions.editFilesExternally ?? false]

			case DiracDefaultTool.EXECUTE_COMMAND:
				return autoApprovalSettings.actions.executeCommands ?? false
			case DiracDefaultTool.BROWSER:
				return autoApprovalSettings.actions.useBrowser
		}
		return false
	}

	async resolveToolPathPermission(
		blockname: DiracDefaultTool,
		autoApproveActionpath: string | undefined,
	): Promise<ToolPermissionDisposition> {
		let isLocal = false
		if (autoApproveActionpath) {
			const { isMultiRootScenario } = await this.getWorkspaceInfo()
			if (isMultiRootScenario) {
				isLocal = await isLocatedInWorkspace(autoApproveActionpath)
			} else {
				const cwd = await getCwd(getDesktopDir())
				const absolutePath = resolveWorkspacePath(
					cwd,
					autoApproveActionpath,
					"AutoApprove.resolveToolPathPermission",
				) as string
				isLocal = isLocatedInPath(cwd, absolutePath)
			}
		}

		const isWriteOperation = WRITE_TOOLS.includes(blockname)
		if (!isLocal && isWriteOperation) return "manual_only"

		const ruleResult = this.commandPermissionController.validateTool(blockname, autoApproveActionpath)
		if (!ruleResult.allowed) return "manual_only"
		if (this.isUnrestrictedAutoApprove()) return "auto_approve"
		if (ruleResult.reason === "allowed" && ruleResult.matchedPattern) return "auto_approve"

		const autoApproveResult = this.shouldAutoApproveTool(blockname)
		const [autoApproveLocal, autoApproveExternal] = Array.isArray(autoApproveResult)
			? autoApproveResult
			: [autoApproveResult, false]
		if ((isLocal && autoApproveLocal) || (!isLocal && autoApproveLocal && autoApproveExternal)) {
			return "auto_approve"
		}
		return "utility_eligible"
	}

	async shouldAutoApproveToolWithPath(
		blockname: DiracDefaultTool,
		autoApproveActionpath: string | undefined,
	): Promise<boolean> {
		let isLocalRead = false
		if (autoApproveActionpath) {
			const { isMultiRootScenario } = await this.getWorkspaceInfo()

			if (isMultiRootScenario) {
				isLocalRead = await isLocatedInWorkspace(autoApproveActionpath)
			} else {
				const cwd = await getCwd(getDesktopDir())
				const absolutePath = resolveWorkspacePath(
					cwd,
					autoApproveActionpath,
					"AutoApprove.shouldAutoApproveToolWithPath",
				) as string
				isLocalRead = isLocatedInPath(cwd, absolutePath)
			}
		}

		if (this.setting("yoloModeToggled")) return true
		if (this.setting("autoApproveAllToggled")) return true

		const isWriteOperation = WRITE_TOOLS.includes(blockname)
		if (!isLocalRead && isWriteOperation) return false

		const autoApproveResult = this.shouldAutoApproveTool(blockname)
		const [autoApproveLocal, autoApproveExternal] = Array.isArray(autoApproveResult)
			? autoApproveResult
			: [autoApproveResult, false]

		if (this.shouldAutoApproveWithRules(blockname, autoApproveActionpath)) return true

		return (isLocalRead && autoApproveLocal) || (!isLocalRead && autoApproveLocal && autoApproveExternal)
	}

	public isCommandAutoApproved(command: string): boolean {
		const entries = this.setting("userApprovedCommands")
		const autoApproveResult = this.shouldAutoApproveTool(DiracDefaultTool.EXECUTE_COMMAND)
		const safeCommandAutoApprovalEnabled = Array.isArray(autoApproveResult) ? autoApproveResult[0] : autoApproveResult

		if (safeCommandAutoApprovalEnabled && isSafeCommand(command)) return true

		return areCommandSegmentsApproved(command, (segment) => {
			if (isUserApprovedCommandSegment(segment, [...entries])) return true
			return safeCommandAutoApprovalEnabled && isSafeCommand(segment)
		})
	}

	/**
	 * Returns true when the user enabled YOLO or Auto-Approve All.
	 * The active permission flow determines whether this override precedes or follows other restrictions.
	 */
	public isUnrestrictedAutoApprove(): boolean {
		return this.setting("yoloModeToggled") || this.setting("autoApproveAllToggled")
	}

	/**
	 * Check if the tool should be auto-approved based on the permission rules.
	 */
	public shouldAutoApproveWithRules(toolName: DiracDefaultTool, path?: string): boolean {
		const result = this.commandPermissionController.validateTool(toolName, path)
		return result.allowed && result.reason === "allowed"
	}
}
