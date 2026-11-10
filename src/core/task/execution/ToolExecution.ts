import type {
	ToolExecutionArguments,
	ToolExecutionCommand,
	ToolExecutionCompletionEvent,
	ToolExecutionContent,
	ToolExecutionIdentity,
	ToolExecutionOriginalResponse,
	ToolExecutionRecord,
	ToolExecutionState,
} from "@shared/toolExecution"

/**
 * Pure lifecycle decisions only. Inputs and outputs are immutable contract data.
 * A runtime must serialize competing decisions with a revision CAS, persist the
 * chosen record and an outbox entry atomically, then publish. These functions do
 * not themselves guarantee durable delivery or authorize protected tool effects.
 */
export function createToolExecution(
	identity: ToolExecutionIdentity,
	toolArguments: ToolExecutionArguments,
): ToolExecutionRecord {
	if (identity.toolSnapshot.requestId !== identity.requestId) {
		throw new Error("Tool execution snapshot must belong to its originating request")
	}
	return {
		identity: { ...identity, owner: { ...identity.owner }, toolSnapshot: { ...identity.toolSnapshot } },
		arguments: structuredClone(toolArguments),
		revision: 0,
		state: { kind: "queued" },
		hasStarted: false,
		cancellation: null,
		originalResponse: null,
		originalResponseCommitted: false,
		completionEvent: null,
	}
}

export class ToolExecutionTransitionError extends Error {
	constructor(
		readonly executionId: string,
		readonly state: ToolExecutionState["kind"],
		readonly command: ToolExecutionCommand["kind"],
	) {
		super(`Illegal tool execution transition for ${executionId}: ${state} + ${command}`)
		this.name = "ToolExecutionTransitionError"
	}
}

function rejectTransition(record: ToolExecutionRecord, command: ToolExecutionCommand): never {
	throw new ToolExecutionTransitionError(record.identity.executionId, record.state.kind, command.kind)
}

function replaceState(record: ToolExecutionRecord, state: ToolExecutionState): ToolExecutionRecord {
	return { ...record, revision: record.revision + 1, state, hasStarted: record.hasStarted || state.kind === "running" }
}

/**
 * The only lifecycle transition function. Cancellation is first-intent-wins and
 * remains distinct from settling and the eventual outcome. In particular,
 * cancellation during settlement cannot rewrite a successful operation result.
 * Running means scheduled to execute, not permission to perform protected effects;
 * the future runtime must recheck authorization and cancellation before effects.
 */
export function transitionToolExecution(
	record: ToolExecutionRecord,
	command: ToolExecutionCommand,
): ToolExecutionRecord {
	switch (command.kind) {
		case "start":
			if (record.state.kind !== "queued") return rejectTransition(record, command)
			return replaceState(record, { kind: "running" })
		case "wait":
			if (record.state.kind === "settling" || record.state.kind === "terminal") {
				return rejectTransition(record, command)
			}
			return replaceState(record, structuredClone(command.waiting))
		case "resume":
			if (
				record.state.kind !== "waiting_permission" &&
				record.state.kind !== "waiting_resource" &&
				record.state.kind !== "waiting_input"
			) {
				return rejectTransition(record, command)
			}
			return replaceState(record, { kind: "running" })
		case "request_cancel":
			if (record.state.kind === "terminal" || record.cancellation !== null) return record
			return { ...record, revision: record.revision + 1, cancellation: structuredClone(command.cancellation) }
		case "mark_response_committed":
			if (record.originalResponse === null) return rejectTransition(record, command)
			if (record.originalResponseCommitted) return record
			return { ...record, revision: record.revision + 1, originalResponseCommitted: true }
		case "begin_settling":
			if (record.state.kind === "settling" || record.state.kind === "terminal") {
				return rejectTransition(record, command)
			}
			return replaceState(record, { kind: "settling", operationOutcome: structuredClone(command.outcome) })
		case "record_settlement_failure":
			if (record.state.kind !== "settling") return rejectTransition(record, command)
			return replaceState(record, { ...record.state, settlementError: structuredClone(command.error) })
		case "finish_settling": {
			if (record.state.kind !== "settling" || command.resourcesSettled !== true) {
				return rejectTransition(record, command)
			}
			const outcome = command.settlementError === undefined
				? record.state.operationOutcome
				: {
					kind: "settlement_failed" as const,
					error: structuredClone(command.settlementError),
					operationOutcome: record.state.operationOutcome,
				}
			return replaceState(record, { kind: "terminal", outcome })
		}
		default:
			return rejectTransition(record, command)
	}
}

/** Inspection never selects the original response, claims completion, or advances a cursor. */
export function inspectToolExecution(record: ToolExecutionRecord): ToolExecutionRecord {
	return record
}

export interface ToolExecutionResponseDecision {
	readonly record: ToolExecutionRecord
	readonly response: ToolExecutionOriginalResponse
	/** False on a retry: the stored decision is returned, not a new publication. */
	readonly newlyChosen: boolean
}

/**
 * Atomically choose exactly one original-response shape at the persisted revision.
 * Terminal wins only if already settled when the choice is made. Otherwise this
 * chooses acceptance even during settlement, reserving completion for an event.
 * Repeating the choice always returns the first decision and its original content.
 */
export function chooseToolExecutionResponse(
	record: ToolExecutionRecord,
	acceptanceContent: ToolExecutionContent,
): ToolExecutionResponseDecision {
	if (record.originalResponse !== null) {
		return { record, response: record.originalResponse, newlyChosen: false }
	}
	const response: ToolExecutionOriginalResponse = record.state.kind === "terminal"
		? { kind: "settled", executionId: record.identity.executionId, outcome: record.state.outcome }
		: { kind: "accepted", executionId: record.identity.executionId, content: structuredClone(acceptanceContent) }
	return {
		record: { ...record, revision: record.revision + 1, originalResponse: response },
		response,
		newlyChosen: true,
	}
}

export interface ToolExecutionCompletionDecision {
	readonly record: ToolExecutionRecord
	readonly event?: ToolExecutionCompletionEvent
	readonly newlyChosen: boolean
}

/**
 * A completion event exists only after committed acceptance AND terminal settlement. This
 * never emits another native result. Persist the claim plus outbox before publish;
 * repeated claims expose the same stable event for recovery, not another event.
 */
export function claimToolExecutionCompletion(record: ToolExecutionRecord): ToolExecutionCompletionDecision {
	if (record.completionEvent !== null) {
		return { record, event: record.completionEvent, newlyChosen: false }
	}
	if (
		record.originalResponse?.kind !== "accepted" ||
		!record.originalResponseCommitted ||
		record.state.kind !== "terminal"
	) {
		return { record, newlyChosen: false }
	}
	const event: ToolExecutionCompletionEvent = {
		kind: "tool_execution_completed",
		eventId: JSON.stringify([
			record.identity.owner.rootTaskId,
			record.identity.owner.taskId,
			record.identity.owner.runId,
			record.identity.executionId,
			"completion",
		]),
		identity: record.identity,
		outcome: record.state.outcome,
	}
	return {
		record: { ...record, revision: record.revision + 1, completionEvent: event },
		event,
		newlyChosen: true,
	}
}
