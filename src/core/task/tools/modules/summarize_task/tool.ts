import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { summarize_task_spec, SummarizeTaskTool } from "./SummarizeTaskTool"

export const spec: DiracToolSpec = summarize_task_spec

export function create(): IDiracTool {
    return new SummarizeTaskTool()
}
