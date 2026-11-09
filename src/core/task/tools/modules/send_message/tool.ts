import type { ToolExposure } from "../../discovery/ToolExposure"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import { SendMessageTool, send_message_spec } from "./SendMessageTool"

export const spec = send_message_spec
export const exposure: ToolExposure = { kind: "context_only" }

export function create(): IDiracTool {
	return new SendMessageTool()
}
