import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import type { ToolConfig } from "../../types/ToolConfig"
import { execute_command_spec, ExecuteCommandTool } from "./ExecuteCommandTool"

export const spec: DiracToolSpec = execute_command_spec

export function create(config?: ToolConfig): IDiracTool {
	if (!config) {
		throw new Error("ExecuteCommandTool requires TaskConfig")
	}
	return new ExecuteCommandTool(
		config.services.diracIgnoreController,
		config.services.commandPermissionController,
		config.autoApprover,
		config.workspaceManager,
		config.isMultiRootEnabled || false,
	)
}
