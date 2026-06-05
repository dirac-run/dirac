import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { plan_mode_respond_spec, PlanModeRespondTool } from "./PlanModeRespondTool"

export const spec: DiracToolSpec = plan_mode_respond_spec

export function create(): IDiracTool {
    return new PlanModeRespondTool()
}
