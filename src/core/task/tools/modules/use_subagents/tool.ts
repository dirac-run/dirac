import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import type { ToolExposure } from "../../discovery/DiscoveredTool"
import { use_subagents_spec, UseSubagentsTool, tasklets_spec, TaskletsTool } from "./UseSubagentsTool"

export const spec: DiracToolSpec = use_subagents_spec
// Running Tasks → Subagents is the sole setting; do not expose a second tool toggle.
export const exposure: ToolExposure = { kind: "context_only" }

export function create(): IDiracTool {
	return new UseSubagentsTool()
}

export const secondarySpec: DiracToolSpec = tasklets_spec
export const secondaryExposure: ToolExposure = { kind: "profile_only", profiles: ["standalone", "goal_coordinator", "goal_followup"] }

export function createSecondary(): IDiracTool {
	return new TaskletsTool()
}
