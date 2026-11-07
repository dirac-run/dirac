/** UI observation only. These values confer no supervision or execution authority. */
export type TaskletObservedState =
	| "starting"
	| "running"
	| "waiting_for_parent"
	| "settling"
	| "settlement_failed"
	| "completed"
	| "failed"
	| "interrupted"
	| "unsettled"

export interface TaskletObservationScope {
	rootTaskId: string
	/** Identifies the selected live host or saved source, not the child. */
	sourceId: string
	availability: "live" | "saved"
}

export interface TaskletActivitySummary extends TaskletObservationScope {
	/** Null for saved history: persisted records cannot establish live execution. */
	activeCount: number | null
}

export interface TaskletInventoryRow {
	taskletId: string
	title: string
	state: TaskletObservedState
}

export interface TaskletInventoryPage extends TaskletObservationScope {
	observedAt: number
	filter: "active" | "all"
	items: TaskletInventoryRow[]
	totalItems: number
	nextCursor?: string
}

/** Deliberately smaller than a Card/DiracMessage: it cannot carry any action capabilities. */
export interface TaskletObservedMessage {
	id: string
	ts: number
	content:
		| { type: "markdown"; content: string; role?: "user" | "assistant"; isReasoning?: boolean }
		| { type: "card"; card: { id: string; header: string; body?: string; status: string } }
}

/** Bounded human presentation, with no child actions or raw model conversation. */
export interface TaskletTranscriptPage extends TaskletObservationScope {
	observedAt: number
	taskletId: string
	title: string
	state: TaskletObservedState
	messages: TaskletObservedMessage[]
	nextCursor?: string
	/** A large individual message is clipped explicitly, never silently. */
	truncatedMessageIds: string[]
	outcome?: { kind: "completed" | "failed" | "interrupted"; summary: string; at: number; truncated: boolean }
}

export const TASKLET_STATE_LABELS: Record<TaskletObservedState, string> = {
	starting: "Starting",
	running: "Running",
	waiting_for_parent: "Waiting for parent",
	settling: "Settling",
	settlement_failed: "Settlement failed",
	completed: "Completed",
	failed: "Failed",
	interrupted: "Interrupted",
	unsettled: "Unsettled (saved)",
}
