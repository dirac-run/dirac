import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { read_file_spec, ReadFileTool } from "./ReadFileTool"

export const spec: DiracToolSpec = read_file_spec

export function create(): IDiracTool {
	return new ReadFileTool()
}
