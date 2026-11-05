import {
	type GoalRecord,
	type GoalStatus,
	type GoalStatusTransition,
	isActiveGoalStatus,
	isSettledGoalStatus,
} from "@shared/goal"

const ALLOWED_STATUS_TRANSITIONS: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
	working: new Set(["waiting", "paused", "blocked", "achieved", "stopped"]),
	waiting: new Set(["working", "paused", "blocked", "achieved", "stopped"]),
	paused: new Set(["working", "stopped"]),
	blocked: new Set(["working", "stopped"]),
	achieved: new Set(),
	stopped: new Set(["working"]),
}

function assertTransitionTime(record: GoalRecord, now: number): void {
	if (!Number.isFinite(now) || now < 0) throw new Error("Goal transition time must be a non-negative finite number")
	if (now < record.updatedAt) throw new Error(`Goal ${record.id} transition time predates its last update`)
	if (record.lastActivatedAt !== undefined && now < record.lastActivatedAt) {
		throw new Error(`Goal ${record.id} transition time predates its active segment`)
	}
}

export function goalActiveDurationAt(record: GoalRecord, now: number): number {
	assertTransitionTime(record, now)
	if (record.lastActivatedAt === undefined) return record.activeDurationMs
	return record.activeDurationMs + (now - record.lastActivatedAt)
}

export function goalWallDurationAt(record: GoalRecord, now: number): number {
	assertTransitionTime(record, now)
	const end = isSettledGoalStatus(record.status) ? record.updatedAt : now
	return end - record.createdAt
}

/**
 * Applies the timing and status portion of one already-serialized lifecycle
 * transition. Repeating a settled transition is an idempotent no-op.
 */
export function applyGoalStatusTransition(record: GoalRecord, transition: GoalStatusTransition, now: number): boolean {
	assertTransitionTime(record, now)
	if (record.status === transition.status) return false
	if (!ALLOWED_STATUS_TRANSITIONS[record.status].has(transition.status)) {
		throw new Error(`Goal ${record.id} cannot transition from ${record.status} to ${transition.status}`)
	}

	const wasActive = isActiveGoalStatus(record.status)
	const becomesActive = isActiveGoalStatus(transition.status)
	if (wasActive && !becomesActive) {
		record.activeDurationMs = goalActiveDurationAt(record, now)
		record.lastActivatedAt = undefined
	} else if (!wasActive && becomesActive) {
		record.lastActivatedAt = now
	}

	if (transition.status === "paused") record.lastPausedAt = now
	record.status = transition.status
	record.statusReason = transition.statusReason?.trim() || undefined
	record.updatedAt = now
	return true
}
