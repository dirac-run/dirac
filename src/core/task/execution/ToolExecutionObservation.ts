import type { ToolExecutionOwner, ToolExecutionRecord, ToolExecutionWaitRequest } from "@shared/toolExecution"
import {
    TOOL_EXECUTION_INLINE_RESULT_BYTES,
    type ToolExecutionInspection,
    type ToolExecutionResultDelivery,
    type ToolExecutionWaitObservation,
} from "@shared/toolExecutionObservation"

/** Preserve complete small results (including images); large results remain retrievable, never truncated. */
export function projectToolExecution(record: ToolExecutionRecord): ToolExecutionInspection {
	const projection: ToolExecutionInspection = {
		identity: record.identity,
		state: record.state.kind,
		hasStarted: record.hasStarted,
		cancellationRequested: record.cancellation !== null,
	}
	if (record.state.kind !== "terminal") return projection
	const utf8Bytes = Buffer.byteLength(JSON.stringify(record.state.outcome), "utf8")
	const result: ToolExecutionResultDelivery = utf8Bytes <= TOOL_EXECUTION_INLINE_RESULT_BYTES
		? { kind: "inline", outcome: record.state.outcome }
		: { kind: "reference", execution_id: record.identity.executionId, outcome_kind: record.state.outcome.kind, view: "result", utf8Bytes }
	return { ...projection, result }
}

export interface ToolExecutionWaitContext {
	readonly owner: ToolExecutionOwner
	readonly observerExecutionId: string
	/** Owner evaluates already-committed records and wake signals at one serialized boundary. */
	readonly wake?: "timeout" | "user_input" | "cancelled"
}

/**
 * Pure observation of a coherent owner snapshot, not waiter registration. The
 * runtime must check this AND register its listener under the same owner lock.
 * Already-settled targets win over a simultaneous deadline or interrupt signal.
 * Otherwise user input/cancellation/timeout end only the wait, never the targets.
 */
export function evaluateToolExecutionWait(
	request: ToolExecutionWaitRequest,
	records: readonly ToolExecutionRecord[],
	context: ToolExecutionWaitContext,
): ToolExecutionWaitObservation | undefined {
	if (request.execution_ids.length === 0 || new Set(request.execution_ids).size !== request.execution_ids.length) {
		throw new Error("Execution wait requires distinct, nonempty targets")
	}
	const byId = new Map<string, ToolExecutionRecord>()
	for (const record of records) {
		if (!sameOwner(record.identity.owner, context.owner)) throw new Error("Execution wait cannot observe another owner run")
		if (byId.has(record.identity.executionId)) throw new Error("Execution snapshot contains duplicate identities")
		byId.set(record.identity.executionId, record)
	}
	const targets = request.execution_ids.map((id) => {
		if (id === context.observerExecutionId) throw new Error("An execution cannot wait for itself")
		const record = byId.get(id)
		if (!record) throw new Error(`Unknown tool execution: ${id}`)
		return record
	})
	const ready = request.mode === "all"
		? targets.every((record) => record.state.kind === "terminal")
		: targets.some((record) => record.state.kind === "terminal")
	const status = ready ? "ready" : context.wake
	if (status === undefined) return undefined
	return { status, executions: targets.map(projectToolExecution) }
}

function sameOwner(left: ToolExecutionOwner, right: ToolExecutionOwner): boolean {
	return left.rootTaskId === right.rootTaskId && left.taskId === right.taskId && left.runId === right.runId
}
