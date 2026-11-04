import type { Card } from "./ExtensionMessage"

export type GoalStatus = "working" | "waiting" | "paused" | "blocked" | "achieved" | "stopped"

export type GoalChildRole = "task" | "verification"

export type GoalChildStatus = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted"

export type GoalInteractionKind = "approval" | "feedback" | "action"

export interface GoalPendingInteraction {
	id: string
	kind: GoalInteractionKind
	createdAt: number
	card: Card
}

export interface GoalChildRecord {
	id: string
	title: string
	role: GoalChildRole
	status: GoalChildStatus
	createdAt: number
	startedAt?: number
	lastActivityAt: number
	endedAt?: number
	terminalSummary?: string
	pendingInteraction?: GoalPendingInteraction
	deliveredResponseCursor: number
}

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

export type GoalEvent =
	| {
			kind: "task_response"
			sequence: number
			taskId: string
			responseCursor: number
			occurredAt: number
	  }
	| {
			kind: "task_interaction"
			sequence: number
			taskId: string
			interactionId: string
			occurredAt: number
	  }
	| { kind: "task_failed"; sequence: number; taskId: string; occurredAt: number }
	| { kind: "task_finished"; sequence: number; taskId: string; occurredAt: number }
	| { kind: "user_steering"; sequence: number; occurredAt: number }

export interface GoalRecord {
	version: 2
	id: string
	conversationUlid: string
	status: GoalStatus
	statusReason?: string
	objective: GoalObjectiveRevision
	createdAt: number
	updatedAt: number
	lastActivatedAt?: number
	lastPausedAt?: number
	activeDurationMs: number
	wakeSequence: number
	lastWakeAt?: number
	eventSequence: number
	events: GoalEvent[]
	children: GoalChildRecord[]
	accountingSources: Record<string, GoalAccounting>
	accounting: GoalAccounting
}

export interface GoalStatusTransition {
	status: GoalStatus
	statusReason?: string
}

export interface GoalTaskSummary extends GoalChildRecord {
	runningDurationMs?: number
	idleDurationMs: number
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
	children: GoalTaskSummary[]
	pendingInteractionCount: number
	latestVerification?: GoalTaskSummary
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

export function isTerminalGoalChildStatus(status: GoalChildStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"
}
