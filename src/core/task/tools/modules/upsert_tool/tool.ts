import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { upsert_tool_spec, UpsertTool } from "./UpsertTool"

export const spec: DiracToolSpec = upsert_tool_spec

export function create(): IDiracTool {
	return new UpsertTool()
}
