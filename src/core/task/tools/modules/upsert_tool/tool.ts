import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import type { ToolExposure } from "../../discovery/DiscoveredTool"
import { upsert_tool_spec, UpsertTool } from "./UpsertTool"

export const spec: DiracToolSpec = upsert_tool_spec

export const exposure: ToolExposure = {
	kind: "skill_only",
	authorizedSkillIds: ["new-tool"],
}

export function create(): IDiracTool {
	return new UpsertTool()
}
