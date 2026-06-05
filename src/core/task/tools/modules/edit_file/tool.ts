import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { edit_file_spec, EditFileTool } from "./EditFileTool"

export const spec: DiracToolSpec = edit_file_spec

export function create(): IDiracTool {
    return new EditFileTool()
}
