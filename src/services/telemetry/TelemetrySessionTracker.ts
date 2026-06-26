/**
 * Tracks per-task aggregate counters (turns, tool calls, errors) across a task's lifecycle.
 * Extracted from TelemetryService to enforce SRP — session tracking is separate from event capture.
 */
export class TelemetrySessionTracker {
	private taskTurnCounts = new Map<string, number>()
	private taskToolCallCounts = new Map<string, number>()
	private taskErrorCounts = new Map<string, number>()

	incrementTurnCount(ulid: string): number {
		return this.increment(this.taskTurnCounts, ulid)
	}

	incrementToolCallCount(ulid: string): number {
		return this.increment(this.taskToolCallCounts, ulid)
	}

	incrementErrorCount(ulid: string): number {
		return this.increment(this.taskErrorCounts, ulid)
	}

	/** Clears all aggregate counters for a task — called on task start, restart, completion, or feedback. */
	resetAggregates(ulid: string): void {
		this.taskTurnCounts.delete(ulid)
		this.taskToolCallCounts.delete(ulid)
		this.taskErrorCounts.delete(ulid)
	}

	private increment(store: Map<string, number>, ulid: string): number {
		const nextValue = (store.get(ulid) ?? 0) + 1
		store.set(ulid, nextValue)
		return nextValue
	}
}
