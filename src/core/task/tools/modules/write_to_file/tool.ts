import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { write_to_file_spec, WriteToFileTool } from "./WriteToFileTool"

export const spec: DiracToolSpec = write_to_file_spec

export function create(): IDiracTool {
	return new WriteToFileTool()
}
