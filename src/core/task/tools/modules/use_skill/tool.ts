import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { use_skill_spec, UseSkillTool } from "./UseSkillTool"

export const spec: DiracToolSpec = use_skill_spec

export function create(): IDiracTool {
    return new UseSkillTool()
}
