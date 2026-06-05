import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { attempt_completion_spec, AttemptCompletionTool } from "./AttemptCompletionTool"

export const spec: DiracToolSpec = attempt_completion_spec

export function create(): IDiracTool {
    return new AttemptCompletionTool()
}
