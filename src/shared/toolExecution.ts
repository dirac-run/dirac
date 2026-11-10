import type { DiracToolResponseContent } from "./messages/content"

/** Contract data only: no task loop, tool implementation, store, or UI dependencies. */
type Immutable<T> = T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T

/** Accepts every existing tool response, including image blocks, without flattening to text. */
export type ToolExecutionContent = Immutable<DiracToolResponseContent>

/** Native tool inputs are JSON data, captured once at admission. */
export type ToolExecutionArgumentValue =
	| null
	| boolean
	| number
	| string
	| readonly ToolExecutionArgumentValue[]
	| { readonly [key: string]: ToolExecutionArgumentValue }

export type ToolExecutionArguments = Readonly<Record<string, ToolExecutionArgumentValue>>

export interface ToolExecutionOwner {
	readonly rootTaskId: string
	readonly taskId: string
	/** A new run has a new identity even when it resumes the same task. */
	readonly runId: string
}

export interface ToolExecutionIdentity {
	readonly executionId: string
	readonly owner: ToolExecutionOwner
	readonly requestId: string
	/** Null for invocations that did not originate in a native model tool call. */
	readonly nativeToolCallId: string | null
	readonly toolName: string
	/** Pins the existing request snapshot identity, not its live coordinator or tool instances. */
	readonly toolSnapshot: {
		readonly requestId: string
		readonly inventoryVersion: number
		readonly configurationRevision?: number
	}
}

/** Serialized structured error; classification never depends on message text. */
export interface ToolExecutionError {
	readonly code: string
	readonly message: string
}

export interface ToolExecutionCancellation {
	readonly requestedBy: ToolExecutionOwner
	readonly requestedAt: number
	readonly reason?: string
}

export type ToolExecutionWorkOutcome =
	| { readonly kind: "success"; readonly content: ToolExecutionContent }
	| { readonly kind: "failure"; readonly error: ToolExecutionError; readonly content?: ToolExecutionContent }
	| { readonly kind: "cancelled"; readonly reason: string; readonly content?: ToolExecutionContent }
	| { readonly kind: "interrupted"; readonly reason: string; readonly content?: ToolExecutionContent }

export type ToolExecutionOutcome =
	| ToolExecutionWorkOutcome
	| {
		readonly kind: "settlement_failed"
		readonly error: ToolExecutionError
		/** The actual operation result is retained even if cleanup/persistence failed. */
		readonly operationOutcome: ToolExecutionWorkOutcome
	}

export type ToolExecutionWaitState =
	| { readonly kind: "waiting_permission"; readonly permissionRequestId: string }
	| { readonly kind: "waiting_resource"; readonly resourceId: string }
	| { readonly kind: "waiting_input"; readonly inputRequestId: string }

export type ToolExecutionState =
	| { readonly kind: "queued" }
	| ToolExecutionWaitState
	| { readonly kind: "running" }
	| {
		readonly kind: "settling"
		readonly operationOutcome: ToolExecutionWorkOutcome
		/** Cleanup failed; resources may still be live and remain owned by this execution. */
		readonly settlementError?: ToolExecutionError
	}
	| { readonly kind: "terminal"; readonly outcome: ToolExecutionOutcome }

export type ToolExecutionOriginalResponse =
	| { readonly kind: "settled"; readonly executionId: string; readonly outcome: ToolExecutionOutcome }
	| { readonly kind: "accepted"; readonly executionId: string; readonly content: ToolExecutionContent }

export interface ToolExecutionCompletionEvent {
	readonly kind: "tool_execution_completed"
	/** Stable outbox/deduplication key, not a second native tool response. */
	readonly eventId: string
	readonly identity: ToolExecutionIdentity
	readonly outcome: ToolExecutionOutcome
}

export interface ToolExecutionRecord {
	readonly identity: ToolExecutionIdentity
	/** Immutable admission snapshot, never reconstructed from later model/configuration state. */
	readonly arguments: ToolExecutionArguments
	/** Compare-and-swap version for a future store; each changed decision increments it. */
	readonly revision: number
	readonly state: ToolExecutionState
	/** True after first entering running; distinguishes pre-start waits from suspended work.
	 * This is not evidence that protected effects occurred or were authorized. */
	readonly hasStarted: boolean
	/** Intent only: does not prove the operation stopped or change its outcome. */
	readonly cancellation: ToolExecutionCancellation | null
	readonly originalResponse: ToolExecutionOriginalResponse | null
	/** True only after the chosen response is durably included in native response history. */
	readonly originalResponseCommitted: boolean
	readonly completionEvent: ToolExecutionCompletionEvent | null
}

export type ToolExecutionCommand =
	| { readonly kind: "start" }
	| { readonly kind: "wait"; readonly waiting: ToolExecutionWaitState }
	| { readonly kind: "resume" }
	| { readonly kind: "request_cancel"; readonly cancellation: ToolExecutionCancellation }
	| { readonly kind: "mark_response_committed" }
	| { readonly kind: "begin_settling"; readonly outcome: ToolExecutionWorkOutcome }
	| { readonly kind: "record_settlement_failure"; readonly error: ToolExecutionError }
	| {
		readonly kind: "finish_settling"
		/** Runtime attestation: no live resources remain owned by this execution. */
		readonly resourcesSettled: true
		/** Omit after successful retry; set for a failed but resource-settled completion. */
		readonly settlementError?: ToolExecutionError
	}

export interface ToolExecutionInspectRequest {
	readonly operation: "inspect"
	readonly execution_id: string
}

export interface ToolExecutionWaitRequest {
	readonly operation: "wait"
	/** Nonempty bounded set of exact execution IDs; callers validate wire inputs. */
	readonly execution_ids: readonly string[]
	readonly mode: "any" | "all"
	/** Omitted means no deadline; zero is nonblocking. Timeout never cancels work. */
	readonly timeout_ms?: number
}

export interface ToolExecutionOutputRequest {
	readonly operation: "output"
	/** Stream text or JSON-serialized full ToolExecutionOutcome fragments. Default: stream. */
	readonly view?: "stream" | "result"
	readonly execution_id: string
	/** Opaque execution-scoped position; omitted means the beginning of retained output. */
	readonly cursor?: string
	/** Maximum UTF-8 bytes of output returned; must be a positive bounded integer. */
	readonly limit: number
}

export interface ToolExecutionCancelRequest {
	readonly operation: "cancel"
	readonly execution_id: string
	readonly reason?: string
}

/** Every observation is nonconsuming; it never chooses a response or claims completion. */
export type ToolExecutionObservationRequest =
	| ToolExecutionInspectRequest
	| ToolExecutionWaitRequest
	| ToolExecutionOutputRequest

export type ToolExecutionControlRequest = ToolExecutionObservationRequest | ToolExecutionCancelRequest

/** Bounded stream text or serialized result fragments; decoding occurs after reassembly. */
export interface ToolExecutionOutputPage {
	readonly view: "stream" | "result"
	readonly execution_id: string
	readonly cursor: string
	readonly next_cursor: string
	/** UTF-8 text fragment, not necessarily independently parseable JSON in result view. */
	readonly output: string
	/** True when retention removed data before the requested position. */
	readonly truncated: boolean
	/** True only once the producer has closed the stream, not merely reached its current end. */
	readonly closed: boolean
}

export interface ToolExecutionWaitResult {
	readonly status: "ready" | "timeout" | "user_input" | "cancelled"
	readonly executions: readonly ToolExecutionRecord[]
}

/** Scheduler action is independent of success/failure and of model-facing response content. */
export type ToolExecutionSchedulerDisposition<Transition> =
	| { readonly kind: "continue" }
	| { readonly kind: "suspend"; readonly wait: ToolExecutionWaitRequest }
	| { readonly kind: "transition"; readonly transition: Transition }
