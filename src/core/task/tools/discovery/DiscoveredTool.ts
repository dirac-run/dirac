import type { DiracToolSpec } from "@/shared/tools";
import type { TaskExecutionProfile } from "../../TaskExecutionProfile";
import type { IDiracTool } from "../interfaces/IDiracTool";
import type { TaskConfig } from "../types/TaskConfig";

export type ToolExposure =
	| { kind: "configurable" }
	/** Available by default; visibility is controlled solely by the spec's contextRequirements. */
	| { kind: "context_only" }
	| { kind: "skill_only"; authorizedSkillIds: readonly string[] }
	| { kind: "profile_only"; profiles: readonly TaskExecutionProfile[] }

export const CONFIGURABLE_TOOL_EXPOSURE: ToolExposure = { kind: "configurable" }
export const GOAL_COORDINATOR_TOOL_EXPOSURE: ToolExposure = {
	kind: "profile_only",
	profiles: ["goal_coordinator", "goal_followup"],
}

export type ToolSource = "builtin" | "global" | "workspace" | "task"

export interface DiscoveredTool {
	/** Unique identifier (e.g., "respond", "my_custom_tool") */
	id: string
	/** LLM-facing name (e.g., "respond") */
	name: string
	/** Where this tool was discovered */
	source: ToolSource
	/** Owning Task for task-scoped tools. Required when source is "task". */
	ownerTaskId?: string
	/** Controls whether this tool is user-configurable, context-only, skill-only, or restricted to execution profiles. */
	exposure: ToolExposure
	/** For LLM API schema generation */
	spec: DiracToolSpec
	/** For runtime instantiation */
	factory: (config?: TaskConfig) => IDiracTool
	/** Filesystem path to the tool.ts manifest */
	modulePath: string
	/** Content fingerprint for a user tool's manifest entrypoint. */
	sourceHash?: string
	/** False for metadata-only entries; must never be instantiated or exposed to a model. */
	executable?: boolean
}
