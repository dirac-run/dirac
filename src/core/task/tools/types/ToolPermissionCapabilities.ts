import type { PermissionValidationResult } from "@core/permissions/types"
import type { DiracDefaultTool } from "@shared/tools"

export type ToolPermissionDisposition = "auto_approve" | "utility_eligible" | "manual_only"

/** Permission policy queries available to tools; never grants or changes authority. */
export interface ToolAutoApproval {
	readonly requiresCounterpartyApproval: boolean
	isUnrestrictedAutoApprove(): boolean
	isCommandAutoApproved(command: string): boolean
	shouldAutoApproveTool(toolName: DiracDefaultTool): boolean | [boolean, boolean]
}

export interface ToolPermissionRules {
	validateTool(tool: string, pattern?: string): PermissionValidationResult
}
