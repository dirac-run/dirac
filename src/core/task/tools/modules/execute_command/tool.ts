import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import type { TaskConfig } from "../../types/TaskConfig"
import { execute_command_spec, ExecuteCommandTool } from "./ExecuteCommandTool"

export const spec: DiracToolSpec = execute_command_spec

export function create(config?: TaskConfig): IDiracTool {
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
