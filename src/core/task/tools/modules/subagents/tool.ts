import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { ToolExposure } from "../../discovery/ToolExposure"
import { subagents_spec, SubagentsTool } from "./SubagentsTool"

export const spec = subagents_spec
// Supervision remains available when creation is disabled; create checks the setting at execution.
export const exposure: ToolExposure = { kind: "profile_only", profiles: ["standalone", "goal_coordinator", "goal_followup"] }

export function create(): IDiracTool {
	return new SubagentsTool()
}
