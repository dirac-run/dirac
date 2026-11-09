import type { DiracToolSpec } from "@/shared/tools";
import type { ToolExposure } from "./ToolExposure"
export { CONFIGURABLE_TOOL_EXPOSURE, GOAL_COORDINATOR_TOOL_EXPOSURE } from "./ToolExposure"
export type { ToolExposure } from "./ToolExposure"
import type { IDiracTool } from "../interfaces/IDiracTool";
import type { ToolConfig } from "../types/ToolConfig";

export type ToolSource = "builtin" | "global" | "workspace" | "task"

export interface DiscoveredTool {
	/** Unique identifier (e.g., "respond", "my_custom_tool") */
	id: string
	/** LLM-facing name (e.g., "respond") */
	name: string
	/** Where this tool was discovered */
	source: ToolSource
	/** Process-local owner key for task tools; tasklets include their root namespace. */
	ownerTaskId?: string
	/** Controls whether this tool is user-configurable, context-only, skill-only, or restricted to execution profiles. */
	exposure: ToolExposure
	/** For LLM API schema generation */
	spec: DiracToolSpec
	/** For runtime instantiation */
	factory: (config?: ToolConfig) => IDiracTool
	/** Filesystem path to the tool.ts manifest */
	modulePath: string
	/** Content fingerprint for a user tool's manifest entrypoint. */
	sourceHash?: string
	/** False for metadata-only entries; must never be instantiated or exposed to a model. */
	executable?: boolean
}
