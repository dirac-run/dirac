import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { search_files_spec, SearchFilesTool } from "./index"

export const spec: DiracToolSpec = search_files_spec

export function create(): IDiracTool {
    return new SearchFilesTool()
}
