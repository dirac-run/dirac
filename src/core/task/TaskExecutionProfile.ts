import type { SkillMetadata } from "@shared/skills"
import type { DiscoveredTool } from "./tools/discovery/DiscoveredTool"

import type { TaskExecutionProfile } from "./TaskExecutionProfileTypes"
export type { TaskExecutionProfile } from "./TaskExecutionProfileTypes"

export function isSkillAvailableToTaskProfile(profile: TaskExecutionProfile, skill: SkillMetadata): boolean {
	if (!skill.foregroundOnly) return true
	return profile === "standalone" || profile === "goal_coordinator" || profile === "goal_followup"
}

export const GOAL_TOOL_NAMES = ["update_goal", "block_goal"] as const

const goalToolNames = new Set<string>(GOAL_TOOL_NAMES)

export function isToolAvailableToTaskProfile(profile: TaskExecutionProfile, toolName: string): boolean {
	if (toolName === "tasklets") return false
	if (toolName === "subagents" && profile === "tasklet") return false
	if (profile === "goal_coordinator" || profile === "goal_followup") return true
	return !goalToolNames.has(toolName)
}

export function isDiscoveredToolAvailableToTaskProfile(profile: TaskExecutionProfile, tool: DiscoveredTool): boolean {
	if (tool.exposure.kind === "profile_only" && !tool.exposure.profiles.includes(profile)) return false
	return isToolAvailableToTaskProfile(profile, tool.spec.name)
}

export function taskProfileSystemInstructions(profile: TaskExecutionProfile, subagentsEnabled = false): string | undefined {
	if (profile === "standalone") return undefined
	if (profile === "tasklet") {
		return `# CONTAINED TASKLET

Work strictly within the complete assignment supplied by the parent. Do not broaden scope without asking the parent. You do not address the end user directly. Report questions, progress, and assignment completion through the respond tool; those messages are routed to the parent and may also be visible in the user timeline. Planning and user-facing proposals belong to the parent.

Keep the parent meaningfully informed during non-trivial work. Report substantive findings, milestones, blockers, and changes of approach, not routine tool narration. Keep progress updates compact.

You always execute in Act mode and cannot call the Plan responder or switch modes. Act execution does not grant authority beyond the parent's current restrictions. You cannot delegate to other agents; ask the parent when additional delegation is needed.`
	}
	const childProgressInstructions = subagentsEnabled
		? "\n\nSynthesize child updates into meaningful user-facing summaries about status, decisions, risks, or next steps. Do not repeat individual communication cards or narrate routine tool activity."
		: ""
	const progressInstructions = `Keep the visible transcript current enough that a user opening it during the run can quickly understand what has been accomplished, what is in progress, and what comes next. Use respond with progress when the overall picture materially changes: after settling on an approach, when meaningful work completes or enters a new phase, when an important finding or blocker changes the plan, or before an extended wait if the last user-visible update no longer describes the current state.${childProgressInstructions}

Keep each progress update compact—normally one sentence, sometimes two, and only rarely three.`
	if (profile === "goal_followup") {
		return `# GOAL FOLLOW-UP

You are continuing the selected Goal coordinator conversation for a user-initiated follow-up turn. The durable Goal lifecycle status is authoritative. This turn must not resume or otherwise change that status.

Calling respond with complete finishes only this follow-up turn; it does not newly achieve the Goal. Calling block_goal ends only this follow-up turn.${subagentsEnabled ? " Both require all tasklets to be terminal." : ""} The user must explicitly resume paused, blocked, or stopped Goal pursuit. An achieved Goal cannot be resumed.

When the Goal is achieved, do not revise its durable objective; it records exactly what was achieved. A materially new objective requires a new Goal.

${progressInstructions}

You always work in Act mode.`
	}
	return `# GOAL COORDINATOR

You are the foreground Goal agent. Communicate progress, questions, blockers, and completion to the user.

${progressInstructions}

Update the durable objective selectively when important intent or constraints must survive compaction. Completion has no automatic verification gate.${subagentsEnabled ? " Goal completion and blocking are valid only when no tasklet is active." : ""} Goal execution is semantically separate from Plan mode and always uses Act tools.`
}
