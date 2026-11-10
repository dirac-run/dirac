import { isDeepStrictEqual } from "node:util"
import type {
	ToolExecutionArguments,
	ToolExecutionContent,
	ToolExecutionIdentity,
	ToolExecutionOwner as OwnerIdentity,
	ToolExecutionRecord,
	ToolExecutionWaitRequest,
	ToolExecutionWaitState,
	ToolExecutionWorkOutcome,
} from "@shared/toolExecution"
import {
	DEFAULT_TOOL_EXECUTION_CAPACITY,
	TOOL_EXECUTION_MAX_WAIT_TARGETS,
	type ToolExecutionAdmissionRejection,
	type ToolExecutionCapacity,
	type ToolExecutionWaitObservation,
} from "@shared/toolExecutionObservation"
import {
	chooseToolExecutionResponse,
	claimToolExecutionCompletion,
	createToolExecution,
	transitionToolExecution,
} from "./ToolExecution"
import { evaluateToolExecutionWait, projectToolExecution } from "./ToolExecutionObservation"
import type { ToolExecutionStore, ToolExecutionStoreSnapshot } from "./ToolExecutionStore"

/** run settles only when the underlying operation has actually stopped, not on an abort request. */
export interface ToolExecutionOperation {
	run(context: ToolExecutionOperationContext): Promise<ToolExecutionWorkOutcome>
	/** Resolution attests that all owned resources are relinquished. Rejection retains ownership. */
	cleanup(): Promise<void>
}

export interface ToolExecutionOperationContext {
	readonly signal: AbortSignal
	waiting(state: ToolExecutionWaitState): Promise<void>
	resume(): Promise<void>
}

export interface ToolExecutionAdmission {
	readonly identity: ToolExecutionIdentity
	readonly arguments: ToolExecutionArguments
	readonly operation: ToolExecutionOperation
}

export interface ToolExecutionOwnerOptions {
	readonly owner: OwnerIdentity
	readonly store: ToolExecutionStore
	readonly capacity?: ToolExecutionCapacity
	readonly now?: () => number
}

export interface ToolExecutionWaitOptions {
	readonly observerExecutionId: string
	/** These signals end the observation only; neither cancels its targets. */
	readonly signal?: AbortSignal
	readonly userInput?: AbortSignal
}

interface OwnedOperation {
	readonly operation: ToolExecutionOperation
	readonly abort: AbortController
	readonly scheduled: Promise<void>
	readonly notifyScheduled: () => void
	started: boolean
	outcome?: ToolExecutionWorkOutcome
	resourcesSettled: boolean
	cleanupError?: Error
	failure?: unknown
	task?: Promise<void>
}

interface Observer {
	readonly request: ToolExecutionWaitRequest
	readonly options: ToolExecutionWaitOptions
	finish(wake?: "timeout" | "user_input" | "cancelled"): void
}

function errorOf(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity): boolean {
	return isDeepStrictEqual(left, right)
}

/**
 * One durable owner/run, independent of model history and UI. Only persisted snapshots
 * are observable. Operation handles and failed persistence attempts remain owned in
 * memory until settlement can be retried; they are never reconstructed by rerunning.
 */
export class ToolExecutionOwner {
	private snapshot: ToolExecutionStoreSnapshot
	private serial: Promise<unknown> = Promise.resolve()
	private shuttingDown = false
	private readonly operations = new Map<string, OwnedOperation>()
	private readonly observers = new Set<Observer>()
	private readonly capacity: ToolExecutionCapacity
	private readonly now: () => number

	private constructor(private readonly options: ToolExecutionOwnerOptions, snapshot: ToolExecutionStoreSnapshot) {
		this.snapshot = snapshot
		this.capacity = { ...(options.capacity ?? DEFAULT_TOOL_EXECUTION_CAPACITY) }
		for (const value of Object.values(this.capacity)) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Execution capacities must be positive integers")
		}
		this.now = options.now ?? Date.now
	}

	static async open(options: ToolExecutionOwnerOptions): Promise<ToolExecutionOwner> {
		const captured = { ...options, owner: structuredClone(options.owner), capacity: options.capacity && { ...options.capacity } }
		const snapshot = await captured.store.load()
		if (!sameOwner(captured.owner, snapshot.owner)) throw new Error("Execution store belongs to another owner run")
		const runtime = new ToolExecutionOwner(captured, snapshot)
		await runtime.recover()
		return runtime
	}

	private exclusive<T>(action: () => Promise<T> | T): Promise<T> {
		const result = this.serial.then(action)
		// The serialization tail is not an error channel; the returned promise is.
		this.serial = result.then(() => undefined, () => undefined)
		return result
	}

	private record(id: string): ToolExecutionRecord {
		const record = this.snapshot.records.find((candidate) => candidate.identity.executionId === id)
		if (!record) throw new Error(`Unknown tool execution: ${id}`)
		return record
	}

	private requireOpen(): void {
		if (this.snapshot.admissionClosed || this.shuttingDown) throw new Error("Tool execution owner is closed")
	}

	private async persist(changes: Partial<ToolExecutionStoreSnapshot>): Promise<void> {
		const next = { ...this.snapshot, ...changes, revision: this.snapshot.revision + 1 }
		if (this.options.store.commitUpdate) {
			const retained = new Set(this.snapshot.records)
			const acknowledged = new Set(this.snapshot.acknowledgedEventIds)
			await this.options.store.commitUpdate(this.snapshot.revision, {
				records: changes.records?.filter((record) => !retained.has(record)),
				admissionClosed: changes.admissionClosed,
				acknowledgeEventIds: changes.acknowledgedEventIds?.filter((id) => !acknowledged.has(id)),
			})
		} else {
			await this.options.store.commit(this.snapshot.revision, next)
		}
		this.snapshot = next
		for (const observer of [...this.observers]) observer.finish()
	}

	private async save(record: ToolExecutionRecord): Promise<void> {
		const claimed = claimToolExecutionCompletion(record).record
		await this.persist({ records: this.snapshot.records.map((old) => old.identity.executionId === record.identity.executionId ? claimed : old) })
	}

	async admit(input: ToolExecutionAdmission): Promise<
		{ readonly kind: "admitted"; readonly executionId: string; readonly replayed: boolean } | ToolExecutionAdmissionRejection
	> {
		// Pin mutable caller data before the first await, including while queued behind a commit.
		const identity = structuredClone(input.identity)
		const args = structuredClone(input.arguments)
		const operation = input.operation
		return this.exclusive(async () => {
			if (!sameOwner(identity.owner, this.options.owner)) throw new Error("Cannot admit a foreign owner execution")
			const duplicate = this.snapshot.records.find((record) => record.identity.executionId === identity.executionId || (
				identity.nativeToolCallId !== null && record.identity.requestId === identity.requestId &&
				record.identity.nativeToolCallId === identity.nativeToolCallId
			))
			if (duplicate) {
				if (!isDeepStrictEqual(duplicate.identity, identity) || !isDeepStrictEqual(duplicate.arguments, args)) {
					throw new Error("Conflicting duplicate tool execution identity or arguments")
				}
				return { kind: "admitted", executionId: identity.executionId, replayed: true }
			}
			if (this.snapshot.admissionClosed || this.shuttingDown) return { kind: "rejected", reason: "owner_closed" }
			if (this.snapshot.records.filter((record) => record.state.kind !== "terminal").length >= this.capacity.maxOwnedWork) {
				return { kind: "rejected", reason: "work_capacity" }
			}
			await this.persist({ records: [...this.snapshot.records, createToolExecution(identity, args)] })
			let notifyScheduled!: () => void
			const scheduled = new Promise<void>((resolve) => { notifyScheduled = resolve })
			this.operations.set(identity.executionId, {
				operation, abort: new AbortController(), started: false, resourcesSettled: false,
				scheduled, notifyScheduled,
			})
			await this.startAvailable(false)
			return { kind: "admitted", executionId: identity.executionId, replayed: false }
		})
	}

	/** Called under the owner lock. Waiting operations retain their running slot. */
	private async startAvailable(propagateFailure = true): Promise<void> {
		// Recovered started work retains its slot until resource reconciliation, too.
		let running = this.snapshot.records.filter((record) => record.hasStarted && record.state.kind !== "terminal").length
		for (const [id, owned] of this.operations) {
			if (running >= this.capacity.maxRunningWork) return
			if (owned.started || owned.outcome) continue
			const record = this.record(id)
			if (record.cancellation || this.snapshot.admissionClosed || this.shuttingDown) continue
			try {
				await this.save(transitionToolExecution(record, { kind: "start" }))
			} catch (error) {
				owned.failure = error
				if (propagateFailure) throw error
				return
			}
			owned.started = true
			running++
			this.track(owned, this.execute(id, owned))
		}
	}

	private track(owned: OwnedOperation, task: Promise<void>): void {
		owned.failure = undefined
		owned.task = task
		owned.notifyScheduled()
		// Background work has an explicit failure channel through join/ownershipFailures/retrySettlement.
		void task.catch((error: unknown) => { owned.failure = error })
	}

	private async execute(id: string, owned: OwnedOperation): Promise<void> {
		try {
			owned.outcome = structuredClone(await owned.operation.run({
				signal: owned.abort.signal,
				waiting: (state) => this.exclusive(async () => {
					await this.save(transitionToolExecution(this.record(id), { kind: "wait", waiting: state }))
				}),
				resume: () => this.exclusive(async () => {
					await this.save(transitionToolExecution(this.record(id), { kind: "resume" }))
				}),
			}))
		} catch (error) {
			owned.outcome = { kind: "failure", error: { code: "OPERATION_REJECTED", message: errorOf(error).message } }
		}
		await this.settle(id, owned)
	}

	/** Cleanup is attempted even when persistence is unavailable; no terminal state is invented. */
	private async settle(id: string, owned: OwnedOperation): Promise<void> {
		let persistenceFailure: unknown
		try {
			await this.exclusive(async () => {
				if (!owned.outcome) throw new Error("Cannot settle an operation that is still running")
				const record = this.record(id)
				if (record.state.kind !== "settling") await this.save(transitionToolExecution(record, { kind: "begin_settling", outcome: owned.outcome }))
			})
		} catch (error) {
			persistenceFailure = error
		}
		if (!owned.resourcesSettled) {
			try {
				if (owned.started) await owned.operation.cleanup()
				owned.resourcesSettled = true
				owned.cleanupError = undefined
			} catch (error) {
				owned.cleanupError = errorOf(error)
			}
		}
		if (persistenceFailure !== undefined) {
			throw new AggregateError([persistenceFailure, ...(owned.cleanupError ? [owned.cleanupError] : [])], "Outcome persistence failed; settlement remains owned for retry")
		}
		await this.exclusive(async () => {
			const record = this.record(id)
			if (owned.cleanupError) {
				await this.save(transitionToolExecution(record, {
					kind: "record_settlement_failure", error: { code: "CLEANUP_FAILED", message: owned.cleanupError.message },
				}))
				throw owned.cleanupError
			}
			await this.save(transitionToolExecution(record, { kind: "finish_settling", resourcesSettled: true }))
			this.operations.delete(id)
			// A scheduling failure belongs to the still-owned queued execution, not this settled one.
			await this.startAvailable(false)
		})
	}

	async inspectRaw(id: string): Promise<ToolExecutionRecord> {
		return this.exclusive(() => structuredClone(this.record(id)))
	}

	async inspect(id: string) {
		return this.exclusive(() => structuredClone(projectToolExecution(this.record(id))))
	}

	async chooseResponse(id: string, acceptance: ToolExecutionContent) {
		const content = structuredClone(acceptance)
		return this.exclusive(async () => {
			const decision = chooseToolExecutionResponse(this.record(id), content)
			if (decision.newlyChosen) await this.save(decision.record)
			return structuredClone(decision.response)
		})
	}

	async markResponseCommitted(id: string): Promise<void> {
		await this.exclusive(async () => {
			const old = this.record(id)
			const next = transitionToolExecution(old, { kind: "mark_response_committed" })
			if (next !== old) await this.save(next)
		})
	}

	async pendingEvents() {
		return this.exclusive(() => structuredClone(this.snapshot.records.flatMap((record) => (
			record.completionEvent && !this.snapshot.acknowledgedEventIds.includes(record.completionEvent.eventId)
				? [record.completionEvent] : []
		))))
	}

	/** Caller attests durable model-history inclusion before acknowledging these stable IDs. */
	async acknowledgeEvents(eventIds: readonly string[]): Promise<void> {
		const ids = [...eventIds]
		await this.exclusive(async () => {
			for (const id of ids) {
				if (!this.snapshot.records.some((record) => record.completionEvent?.eventId === id)) throw new Error(`Unknown completion event: ${id}`)
			}
			const next = [...new Set([...this.snapshot.acknowledgedEventIds, ...ids])]
			if (next.length !== this.snapshot.acknowledgedEventIds.length) await this.persist({ acknowledgedEventIds: next })
		})
	}

	async wait(request: ToolExecutionWaitRequest, options: ToolExecutionWaitOptions): Promise<ToolExecutionWaitObservation | ToolExecutionAdmissionRejection> {
		const captured = structuredClone(request)
		options = { ...options }
		if (captured.execution_ids.length > TOOL_EXECUTION_MAX_WAIT_TARGETS) throw new Error("Too many execution wait targets")
		if (captured.mode !== "any" && captured.mode !== "all") throw new Error("Unknown execution wait mode")
		if (captured.timeout_ms !== undefined && (!Number.isSafeInteger(captured.timeout_ms) || captured.timeout_ms < 0 || captured.timeout_ms > 2_147_483_647)) {
			throw new Error("Invalid execution wait timeout")
		}
		// Return a holder rather than a promise: the owner lock must not await the observation.
		const holder = await this.exclusive(() => {
			if (this.snapshot.admissionClosed || this.shuttingDown) return { result: Promise.resolve<ToolExecutionAdmissionRejection>({ kind: "rejected", reason: "owner_closed" }) }
			const evaluate = (wake?: "timeout" | "user_input" | "cancelled") => evaluateToolExecutionWait(captured, this.snapshot.records, {
				owner: this.options.owner, observerExecutionId: options.observerExecutionId, wake,
			})
			const initial = evaluate(options.signal?.aborted ? "cancelled" : options.userInput?.aborted ? "user_input" : captured.timeout_ms === 0 ? "timeout" : undefined)
			if (initial) return { result: Promise.resolve(structuredClone(initial)) }
			if (this.observers.size >= this.capacity.maxWaitingObservers) return { result: Promise.resolve<ToolExecutionAdmissionRejection>({ kind: "rejected", reason: "wait_capacity" }) }
			let resolve!: (result: ToolExecutionWaitObservation) => void
			const result = new Promise<ToolExecutionWaitObservation>((done) => { resolve = done })
			let timer: ReturnType<typeof setTimeout> | undefined
			const cancel = () => { void this.exclusive(() => observer.finish("cancelled")) }
			const input = () => { void this.exclusive(() => observer.finish("user_input")) }
			const observer: Observer = {
				request: captured, options,
				finish: (wake) => {
					const observation = evaluate(wake)
					if (!observation) return
					this.observers.delete(observer)
					if (timer !== undefined) clearTimeout(timer)
					options.signal?.removeEventListener("abort", cancel)
					options.userInput?.removeEventListener("abort", input)
					resolve(structuredClone(observation))
				},
			}
			this.observers.add(observer)
			options.signal?.addEventListener("abort", cancel, { once: true })
			options.userInput?.addEventListener("abort", input, { once: true })
			if (captured.timeout_ms !== undefined) timer = setTimeout(() => { void this.exclusive(() => observer.finish("timeout")) }, captured.timeout_ms)
			return { result }
		})
		return holder.result
	}

	async cancel(id: string, reason?: string): Promise<void> {
		await this.exclusive(async () => {
			this.requireOpen()
			await this.cancelOwned(id, reason)
		})
	}

	private async cancelOwned(id: string, reason?: string): Promise<void> {
		const old = this.record(id)
		const next = transitionToolExecution(old, {
			kind: "request_cancel", cancellation: { requestedBy: this.options.owner, requestedAt: this.now(), reason },
		})
		if (next !== old) await this.save(next)
		this.abortOwned(id, next.cancellation?.reason)
	}

	private abortOwned(id: string, reason?: string): void {
		const owned = this.operations.get(id)
		if (!owned) return
		owned.abort.abort(reason)
		if (!owned.started && !owned.outcome) {
			owned.outcome = { kind: "cancelled", reason: reason ?? "Cancelled before start" }
			this.track(owned, this.settle(id, owned))
		}
	}

	/** Joins actual run and cleanup, not merely cancellation intent or the model response. */
	async join(id: string): Promise<ToolExecutionRecord> {
		const owned = await this.exclusive(() => { this.record(id); return this.operations.get(id) })
		if (owned) {
			await owned.scheduled
			await owned.task
		}
		const record = await this.inspectRaw(id)
		if (record.state.kind !== "terminal") throw new Error("Execution requires resource reconciliation before it can be joined")
		return record
	}

	async retrySettlement(id: string): Promise<void> {
		const owned = await this.exclusive(() => {
			const operation = this.operations.get(id)
			if (!operation?.outcome) throw new Error("Execution has no retained settlement to retry")
			return operation
		})
		const previous = owned.task
		await previous?.catch(() => undefined)
		await this.exclusive(() => {
			if (owned.task === previous && this.operations.get(id) === owned) this.track(owned, this.settle(id, owned))
		})
		await owned.task
	}

	async retryPending(): Promise<void> {
		await this.exclusive(() => this.startAvailable())
	}

	async ownershipFailures(): Promise<readonly { executionId: string; error: unknown }[]> {
		return this.exclusive(() => [...this.operations].flatMap(([executionId, owned]) => owned.failure === undefined ? [] : [{ executionId, error: owned.failure }]))
	}

	private blockers(excludeExecutionId?: string): readonly ToolExecutionRecord[] {
		return this.snapshot.records.filter((record) => record.identity.executionId !== excludeExecutionId && (
			record.state.kind !== "terminal" ||
			((record.identity.nativeToolCallId !== null || record.originalResponse !== null) && !record.originalResponseCommitted) ||
			(record.completionEvent !== null && !this.snapshot.acknowledgedEventIds.includes(record.completionEvent.eventId))
		))
	}

	async completionBlockers(excludeExecutionId?: string): Promise<readonly ToolExecutionRecord[]> {
		return this.exclusive(() => structuredClone(this.blockers(excludeExecutionId)))
	}

	/** Atomic completion gate: close admission only when no work or delivery debt remains. */
	async prepareCompletion(excludeExecutionId?: string): Promise<readonly ToolExecutionRecord[]> {
		return this.exclusive(async () => {
			const blockers = this.blockers(excludeExecutionId)
			if (blockers.length === 0 && !this.snapshot.admissionClosed) {
				await this.persist({ admissionClosed: true })
				for (const observer of [...this.observers]) observer.finish("cancelled")
			}
			return structuredClone(blockers)
		})
	}

	async closeAdmission(): Promise<void> {
		await this.exclusive(async () => {
			if (!this.snapshot.admissionClosed) await this.persist({ admissionClosed: true })
			for (const observer of [...this.observers]) observer.finish("cancelled")
		})
	}

	async shutdown(): Promise<void> {
		const shutdown = await this.exclusive(async () => {
			// Resource relinquishment cannot depend on storage availability. This local
			// gate is deliberately not represented as an unpersisted snapshot change.
			this.shuttingDown = true
			const failures: unknown[] = []
			try {
				if (!this.snapshot.admissionClosed) await this.persist({ admissionClosed: true })
			} catch (error) { failures.push(error) }
			for (const observer of [...this.observers]) observer.finish("cancelled")
			const ids = this.snapshot.records.filter((record) => record.state.kind !== "terminal").map((record) => record.identity.executionId)
			for (const id of ids) {
				try {
					await this.cancelOwned(id, "Owner shutdown")
				} catch (error) {
					failures.push(error)
					this.abortOwned(id, "Owner shutdown (cancellation persistence failed)")
				}
				const owned = this.operations.get(id)
				if (owned?.outcome && owned.failure !== undefined) this.track(owned, this.settle(id, owned))
			}
			return { ids, failures }
		})
		const results = await Promise.allSettled(shutdown.ids.map((id) => this.join(id)))
		const failures = [...shutdown.failures, ...results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])]
		if (failures.length) throw new AggregateError(failures, "Tool execution shutdown did not settle all owned work")
	}

	private async recover(): Promise<void> {
		const records = this.snapshot.records.map((record) => {
			if (record.state.kind === "terminal") return claimToolExecutionCompletion(record).record
			const settling = record.state.kind === "settling" ? record : transitionToolExecution(record, {
				kind: "begin_settling", outcome: { kind: "interrupted", reason: "Owner runtime restarted; operation is not replayed" },
			})
			if (!record.hasStarted) return claimToolExecutionCompletion(transitionToolExecution(settling, { kind: "finish_settling", resourcesSettled: true })).record
			return transitionToolExecution(settling, {
				kind: "record_settlement_failure", error: {
					code: "RESOURCE_RECONCILIATION_REQUIRED", message: "Restart cannot establish whether external resources have settled",
				},
			})
		})
		if (!isDeepStrictEqual(records, this.snapshot.records)) await this.persist({ records })
	}

	/** Explicit adapter attestation, never an inference from process/runtime loss. */
	async reconcileInterrupted(id: string, attestation: { readonly resourcesSettled: true }): Promise<void> {
		await this.exclusive(async () => {
			if (attestation.resourcesSettled !== true || this.operations.has(id)) throw new Error("Cannot reconcile live owner resources")
			const record = this.record(id)
			if (record.state.kind !== "settling" || record.state.settlementError?.code !== "RESOURCE_RECONCILIATION_REQUIRED") throw new Error("Execution does not require recovery reconciliation")
			await this.save(transitionToolExecution(record, { kind: "finish_settling", resourcesSettled: true }))
			await this.startAvailable(false)
		})
	}
}
