import type { ToolExecutionOwner } from "@shared/toolExecution"

export interface SupervisedToolExecutionOwner {
	closeAdmission(): Promise<void>
	shutdown(): Promise<void>
}

interface OwnedRun {
	readonly identity: ToolExecutionOwner
	readonly parentKey: string | null
	readonly runtime: SupervisedToolExecutionOwner
}

/** Root-scoped ownership tree, not a tasklet or conversation lifetime owner. */
export class ToolExecutionSupervision {
	private readonly runs = new Map<string, OwnedRun>()
	private readonly closing = new Set<string>()

	constructor(private readonly rootTaskId: string) {}

	register(identity: ToolExecutionOwner, runtime: SupervisedToolExecutionOwner, parent: ToolExecutionOwner | null): void {
		if (identity.rootTaskId !== this.rootTaskId) throw new Error("Execution owner belongs to another root")
		const key = ownerKey(identity)
		if (this.runs.has(key)) throw new Error("Execution owner run is already registered")
		if (this.closing.has(key)) throw new Error("Execution owner run is closing")
		if (parent === null) {
			if (identity.taskId !== this.rootTaskId || this.runs.size !== 0)
				throw new Error("Only the root run may register without a parent")
		} else {
			const parentKey = ownerKey(parent)
			if (!this.runs.has(parentKey)) throw new Error("Execution owner parent is not registered")
			if (this.closing.has(parentKey)) throw new Error("Execution owner parent is closing")
		}
		this.runs.set(key, { identity: { ...identity }, parentKey: parent === null ? null : ownerKey(parent), runtime })
	}

	/**
	 * Seal subtree registration synchronously before awaiting any admission writes.
	 * A failure in one owner never prevents siblings from receiving shutdown; the
	 * caller receives all failures and may retry. Runs remain supervised throughout.
	 */
	async shutdown(identity: ToolExecutionOwner): Promise<void> {
		const key = ownerKey(identity)
		if (!this.runs.has(key)) throw new Error("Unknown execution owner run")
		const descendants = this.subtree(key)
		for (const run of descendants) this.closing.add(ownerKey(run.identity))
		const closures = await Promise.allSettled(
			descendants.map((run) => Promise.resolve().then(() => run.runtime.closeAdmission())),
		)
		const settlements = await Promise.allSettled(
			descendants.map((run) => Promise.resolve().then(() => run.runtime.shutdown())),
		)
		const failures = [...closures, ...settlements].flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
		if (failures.length > 0) throw new AggregateError(failures, "Execution subtree did not settle cleanly")
	}

	private subtree(parentKey: string): OwnedRun[] {
		const parent = this.runs.get(parentKey)!
		const result = [parent]
		for (const run of this.runs.values()) {
			if (run.parentKey === parentKey) result.push(...this.subtree(ownerKey(run.identity)))
		}
		return result
	}
}

function ownerKey(owner: ToolExecutionOwner): string {
	return JSON.stringify([owner.rootTaskId, owner.taskId, owner.runId])
}
