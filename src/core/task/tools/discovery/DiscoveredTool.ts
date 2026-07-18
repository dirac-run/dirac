import type { DiracToolSpec } from "@/shared/tools"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { TaskConfig } from "../types/TaskConfig"

export type ToolExposure =
	| { kind: "configurable" }
	| { kind: "skill_only"; authorizedSkillIds: readonly string[] }

export const CONFIGURABLE_TOOL_EXPOSURE: ToolExposure = { kind: "configurable" }

export type ToolSource = "builtin" | "global" | "workspace" | "task"

export interface DiscoveredTool {
	/** Unique identifier (e.g., "say", "my_custom_tool") */
	id: string
	/** LLM-facing name (e.g., "say") */
	name: string
	/** Where this tool was discovered */
	source: ToolSource
	/** Controls whether this tool is user-configurable or only available through an authorized skill. */
	exposure: ToolExposure
	/** For LLM API schema generation */
	spec: DiracToolSpec
	/** For runtime instantiation */
	factory: (config?: TaskConfig) => IDiracTool
	/** Filesystem path to the tool.ts manifest */
	modulePath: string
	/** Content fingerprint for a user tool's manifest entrypoint. */
	sourceHash?: string
}
