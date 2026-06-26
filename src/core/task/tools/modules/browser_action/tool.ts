import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { browser_action_spec, BrowserActionTool } from "./BrowserActionTool"

export const spec: DiracToolSpec = browser_action_spec

export function create(): IDiracTool {
	return new BrowserActionTool()
}
