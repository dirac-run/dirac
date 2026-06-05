import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { use_subagents_spec, UseSubagentsTool } from "./UseSubagentsTool"

export const spec: DiracToolSpec = use_subagents_spec

export function create(): IDiracTool {
    return new UseSubagentsTool()
}
