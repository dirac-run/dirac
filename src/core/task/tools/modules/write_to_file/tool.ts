import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { write_to_file_spec, WriteToFileTool, new_rule_spec, NewRuleTool } from "./WriteToFileTool"

export const spec: DiracToolSpec = write_to_file_spec

export function create(): IDiracTool {
	return new WriteToFileTool()
}

export const secondarySpec: DiracToolSpec = new_rule_spec

export function createSecondary(): IDiracTool {
	return new NewRuleTool()
}
