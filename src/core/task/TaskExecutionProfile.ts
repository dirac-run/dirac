import type { SkillMetadata } from "@shared/skills"
import type { DiscoveredTool } from "./tools/discovery/DiscoveredTool"

export type TaskExecutionProfile = "standalone" | "goal_coordinator" | "goal_followup" | "goal_child" | "tasklet"

export function isSkillAvailableToTaskProfile(
	profile: TaskExecutionProfile,
	skill: SkillMetadata,
): boolean {
	if (!skill.foregroundOnly) return true
	return profile === "standalone" || profile === "goal_coordinator" || profile === "goal_followup"
}

export const GOAL_TOOL_NAMES = [
	"start_task",
	"list_tasks",
	"send_task_message",
	"cancel_task",
	"read_task_transcript",
	"resolve_task_interaction",
	"wait_for_goal_events",
	"verify_goal",
	"update_goal",
	"block_goal",
] as const

const goalToolNames = new Set<string>(GOAL_TOOL_NAMES)

export function isToolAvailableToTaskProfile(profile: TaskExecutionProfile, toolName: string): boolean {
	if ((toolName === "use_subagents" || toolName === "tasklets") && profile !== "standalone") return false
	if (profile === "goal_coordinator" || profile === "goal_followup") return true
	return !goalToolNames.has(toolName)
}

export function isDiscoveredToolAvailableToTaskProfile(profile: TaskExecutionProfile, tool: DiscoveredTool): boolean {
	if (tool.exposure.kind === "profile_only" && !tool.exposure.profiles.includes(profile)) return false
	return isToolAvailableToTaskProfile(profile, tool.spec.name)
}

export function taskProfileSystemInstructions(profile: TaskExecutionProfile): string | undefined {
	if (profile === "standalone") return undefined
	if (profile === "tasklet") {
		return `# CONTAINED TASKLET

You are a private worker for a parent agent. Work strictly within the complete assignment supplied by the parent. Do not broaden scope without asking the parent. You do not communicate with the end user. Report questions, plans, progress, and completion through the respond tool; those responses are delivered privately to the parent.

Keep the parent meaningfully informed during non-trivial work. Report substantive findings, milestones, blockers, and changes of approach, not routine tool narration. Keep progress updates compact.

Follow the current Plan or Act mode and its normal tool restrictions. You cannot delegate to other agents; ask the parent when additional delegation is needed.`
	}
	if (profile === "goal_child") {
		return `# CONTAINED GOAL TASK

You are a private worker for a parent Goal agent. Work strictly within the complete assignment in the first user message. Do not broaden scope without asking the parent. You do not communicate with the end user. Report questions, plans, and completion through the respond tool; those responses are delivered privately to the parent Goal agent.

Keep the parent meaningfully informed during non-trivial work. Use respond with progress when you establish your approach, reach a substantive finding or milestone, encounter a blocker, or materially change direction. For work spanning multiple phases, do not save every useful update for completion. These are trajectory updates, not routine tool narration or a timed cadence. Keep each progress update compact—normally one sentence, sometimes two, and only rarely three.

You always work in Act mode.`
	}
	if (profile === "goal_followup") {
		return `# GOAL FOLLOW-UP

You are continuing the selected Goal coordinator conversation for a user-initiated follow-up turn. The durable Goal lifecycle status is authoritative. This turn must not resume or otherwise change that status.

You may work directly and use contained Tasks or verification when useful. Calling respond with complete finishes only this follow-up turn; it does not newly achieve the Goal. Calling block_goal ends only this follow-up turn. The user must explicitly resume paused, blocked, or stopped Goal pursuit. An achieved Goal cannot be resumed.

When the Goal is achieved, do not revise its durable objective; it records exactly what was achieved. A materially new objective requires a new Goal.

Keep the visible transcript current enough that a user opening it during the run can quickly understand what has been accomplished, what is in progress, and what comes next. Use respond with progress when the overall picture materially changes: after settling on an approach, when meaningful work completes or enters a new phase, when an important finding or blocker changes the plan, or before an extended wait if the last user-visible update no longer describes the current state.

Exercise judgment over child updates. Most should remain private; synthesize only information that helps the user understand status, decisions, risks, or next steps. Do not mechanically forward child messages or narrate routine tool activity. Keep each progress update compact—normally one sentence, sometimes two, and only rarely three.

You always work in Act mode.`
	}
	return `# GOAL COORDINATOR

You are the foreground Goal agent. You may work directly and may create private contained Tasks. Only you communicate progress, questions, blockers, and completion to the user.

Keep the visible transcript current enough that a user opening it during the run can quickly understand what has been accomplished, what is in progress, and what comes next. Use respond with progress when the overall picture materially changes: after settling on an approach, when meaningful work completes or enters a new phase, when an important finding or blocker changes the plan, or before an extended wait if the last user-visible update no longer describes the current state.

Exercise judgment over child updates. Most should remain private; synthesize only information that helps the user understand status, decisions, risks, or next steps. Do not mechanically forward child messages or narrate routine tool activity. Keep each progress update compact—normally one sentence, sometimes two, and only rarely three.

Keep contained assignments narrow and complete, inspect live Tasks when steering may affect them, and use wait_for_goal_events when no immediate action remains. Update the durable objective selectively when important intent or constraints must survive compaction. A Goal completion is valid only when no contained Task is active. Goal execution is semantically separate from Plan mode and always uses Act tools.`
}
