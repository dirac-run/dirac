
export type GoalStatus = "working" | "waiting" | "paused" | "blocked" | "achieved" | "stopped"


export interface GoalAccounting {
	totalTokens?: number
	inputTokens?: number
	outputTokens?: number
	reasoningTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	cost?: number
}

export interface GoalObjectiveRevision {
	markdown: string
	revision: number
	updatedAt: number
}

/** Goal lifecycle and replaceable accounting projections; tasklets own child state. */
export interface GoalRecord {
	version: 2
	id: string
	conversationUlid: string
	status: GoalStatus
	statusReason?: string
	objective: GoalObjectiveRevision
	createdAt: number
	updatedAt: number
	/** Terminal lifecycle time, independent of later follow-up accounting updates. */
	settledAt?: number
	lastActivatedAt?: number
	lastPausedAt?: number
	activeDurationMs: number
	accountingSources: Record<string, GoalAccounting>
	accounting: GoalAccounting
}

export interface GoalStatusTransition {
	status: GoalStatus
	statusReason?: string
}


export interface GoalViewState {
	id: string
	status: GoalStatus
	followUpActive: boolean
	/** Local coordinator ownership, not a claim that no other process owns this Goal. */
	hasLocalExecution?: boolean
	statusReason?: string
	objective: GoalObjectiveRevision
	createdAt: number
	updatedAt: number
	wallDurationMs: number
	activeDurationMs: number
	accounting: GoalAccounting
	mode: "act"
	modeSwitchingDisabled: true
	modeSwitchingExplanation: string
}

export const GOAL_MODE_SWITCHING_EXPLANATION = "Mode switching is disabled while a Goal is active."

export function isSettledGoalStatus(status: GoalStatus): boolean {
	return status === "achieved" || status === "stopped"
}

export function isActiveGoalStatus(status: GoalStatus): boolean {
	return status === "working" || status === "waiting"
}

export function isResumableGoalStatus(status: GoalStatus): boolean {
	return status === "paused" || status === "blocked" || status === "stopped"
}
