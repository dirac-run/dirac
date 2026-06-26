import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { list_files_spec, ListFilesTool } from "./index"

export const spec: DiracToolSpec = list_files_spec

export function create(): IDiracTool {
	return new ListFilesTool()
}
