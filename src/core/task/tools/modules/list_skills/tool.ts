import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { list_skills_spec, ListSkillsTool } from "./ListSkillsTool"

export const spec: DiracToolSpec = list_skills_spec

export function create(): IDiracTool {
    return new ListSkillsTool()
}
