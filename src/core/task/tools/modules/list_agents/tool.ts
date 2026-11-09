import type { ToolExposure } from "../../discovery/ToolExposure"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import { ListAgentsTool, list_agents_spec } from "./ListAgentsTool"

export const spec = list_agents_spec
export const exposure: ToolExposure = { kind: "context_only" }

export function create(): IDiracTool {
	return new ListAgentsTool()
}
