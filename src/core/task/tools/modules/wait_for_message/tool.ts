import type { ToolExposure } from "../../discovery/ToolExposure"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import { WaitForMessageTool, wait_for_message_spec } from "./WaitForMessageTool"

export const spec = wait_for_message_spec
export const exposure: ToolExposure = { kind: "profile_only", profiles: ["tasklet"] }

export function create(): IDiracTool { return new WaitForMessageTool() }
