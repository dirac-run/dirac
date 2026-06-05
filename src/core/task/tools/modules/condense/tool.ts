import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { condense_spec, CondenseTool } from "./CondenseTool"

export const spec: DiracToolSpec = condense_spec

export function create(): IDiracTool {
    return new CondenseTool()
}
