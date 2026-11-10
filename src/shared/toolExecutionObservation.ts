import type {
	ToolExecutionIdentity,
	ToolExecutionOutcome,
	ToolExecutionState,
} from "./toolExecution"

/** Payload limits exclude the small identity/status envelope; no content is silently truncated. */
export const TOOL_EXECUTION_INLINE_RESULT_BYTES = 16 * 1024
export const TOOL_EXECUTION_OUTPUT_PAGE_BYTES = 16 * 1024
export const TOOL_EXECUTION_MAX_OUTPUT_PAGE_BYTES = 64 * 1024
export const TOOL_EXECUTION_MAX_WAIT_TARGETS = 32

export type ToolExecutionResultDelivery =
	| { readonly kind: "inline"; readonly outcome: ToolExecutionOutcome }
	| {
		readonly kind: "reference"
		readonly execution_id: string
		readonly outcome_kind: ToolExecutionOutcome["kind"]
		/** JSON-serialized full outcome, including image content, retained until owner history deletion. */
		readonly view: "result"
		readonly utf8Bytes: number
	}

/** Model/UI projection, distinct from the full persisted record and its potentially large arguments. */
export interface ToolExecutionInspection {
	readonly identity: ToolExecutionIdentity
	readonly state: ToolExecutionState["kind"]
	readonly hasStarted: boolean
	readonly cancellationRequested: boolean
	readonly result?: ToolExecutionResultDelivery
}

export interface ToolExecutionWaitObservation {
	readonly status: "ready" | "timeout" | "user_input" | "cancelled"
	/** One snapshot per requested ID in request order, including targets still running on an early wake. */
	readonly executions: readonly ToolExecutionInspection[]
}

/**
 * Applied by the owner, not by individual tools. Work and waiting observations
 * have separate capacities: a wait never occupies the slot needed by its target.
 * Inspect/output/cancel are short control operations and bypass these work/wait
 * budgets. Closure rejects new work, waits and cancellation requests; retained
 * inspection/output remain readable for settlement diagnostics and history.
 */
export interface ToolExecutionCapacity {
	readonly maxOwnedWork: number
	readonly maxRunningWork: number
	readonly maxWaitingObservers: number
}

export const DEFAULT_TOOL_EXECUTION_CAPACITY: ToolExecutionCapacity = {
	maxOwnedWork: 128,
	maxRunningWork: 16,
	maxWaitingObservers: 16,
}

/** Admission rejection has no execution ID and launches no operation. */
export type ToolExecutionAdmissionRejection = {
	readonly kind: "rejected"
	readonly reason: "owner_closed" | "work_capacity" | "wait_capacity"
}
