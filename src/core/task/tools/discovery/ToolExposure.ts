import type { TaskExecutionProfile } from "../../TaskExecutionProfileTypes"

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

