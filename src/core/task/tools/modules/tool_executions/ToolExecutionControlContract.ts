import type { ToolExecutionControlRequest, ToolExecutionObservationRequest } from "@shared/toolExecution"
import type { DiracToolSpec } from "@shared/tools"

import {
	TOOL_EXECUTION_MAX_WAIT_TARGETS as MAX_EXECUTION_WAIT_TARGETS,
	TOOL_EXECUTION_OUTPUT_PAGE_BYTES as DEFAULT_EXECUTION_OUTPUT_BYTES,
	TOOL_EXECUTION_MAX_OUTPUT_PAGE_BYTES as MAX_EXECUTION_OUTPUT_BYTES,
} from "@shared/toolExecutionObservation"

export { MAX_EXECUTION_WAIT_TARGETS, DEFAULT_EXECUTION_OUTPUT_BYTES, MAX_EXECUTION_OUTPUT_BYTES }
export const MAX_EXECUTION_WAIT_MS = 2_147_483_647

/** Registered only when the execution owner and scheduler implement this contract. */
export const tool_executions_spec: DiracToolSpec = {
	id: "tool_executions",
	name: "tool_executions",
	description:
		"Observe or cancel this agent run's tool executions. Inspect and output are non-consuming reads. Wait suspends reasoning until any/all named executions settle, a deadline expires, user input arrives, or the wait is cancelled; it does not cancel targets or consume their completion events. Cancel requests cancellation, not proof of settlement. Execution IDs are not subagent IDs. Completion events remain correlated with the original tool call; inspect/wait have their own call identities.",
	parameters: [
		{ name: "operation", required: true, enum: ["inspect", "output", "wait", "cancel"], instruction: "Observation or cancellation operation." },
		{ name: "execution_id", required: false, minLength: 1, instruction: "Required for inspect, output, and cancel; one execution owned by this agent run." },
		{
			name: "execution_ids", type: "array", required: false, minItems: 1, maxItems: MAX_EXECUTION_WAIT_TARGETS,
			uniqueItems: true, items: { type: "string", minLength: 1 },
			instruction: "Required for wait; distinct execution IDs, excluding this control call. Results preserve this order.",
		},
		{ name: "mode", required: false, enum: ["any", "all"], instruction: "Wait only: any target settled (default) or all targets settled. Failed/cancelled/interrupted targets also count as settled." },
		{ name: "timeout_ms", type: "integer", required: false, minimum: 0, maximum: MAX_EXECUTION_WAIT_MS, instruction: "Wait only: deadline in milliseconds. Omit for no deadline; zero checks immediately. Expiration never cancels target work." },
		{ name: "cursor", required: false, minLength: 1, instruction: "Output only: opaque cursor returned by an earlier page for this execution; omit to start." },
		{ name: "view", required: false, enum: ["stream", "result"], instruction: "Output only: stream (default) for incremental text; result for JSON-serialized terminal outcome, including image content. Concatenate result fragments before parsing JSON." },
		{ name: "limit", type: "integer", required: false, minimum: 4, maximum: MAX_EXECUTION_OUTPUT_BYTES, instruction: `Output only: UTF-8 payload byte budget, default ${DEFAULT_EXECUTION_OUTPUT_BYTES}; minimum four bytes permits any Unicode character. Oversized entries are retrieved in fragments, not silently truncated.` },
		{ name: "reason", required: false, minLength: 1, instruction: "Cancel only: optional reason. Cancellation remains pending until the execution actually settles." },
	],
}

/** Input has already passed the common provider-optional-parameter normalization. */
export function parseToolExecutionControl(input: unknown): ToolExecutionObservationRequest | ToolExecutionControlRequest {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("tool_executions arguments must be an object")
	const args = input as Record<string, unknown>
	switch (args.operation) {
		case "inspect":
			rejectFields(args, ["operation", "execution_id"])
			return { operation: "inspect", execution_id: requireString(args, "execution_id") }
		case "output": {
			rejectFields(args, ["operation", "execution_id", "cursor", "limit", "view"])
			const execution_id = requireString(args, "execution_id")
			const cursor = args.cursor === undefined ? undefined : requireString(args, "cursor")
			const limit = args.limit === undefined ? DEFAULT_EXECUTION_OUTPUT_BYTES : requireInteger(args, "limit", 4, MAX_EXECUTION_OUTPUT_BYTES)
			const view = args.view
			if (view !== undefined && view !== "stream" && view !== "result") throw new Error("view must be stream or result")
			return { operation: "output", execution_id, ...(cursor === undefined ? {} : { cursor }), ...(view === undefined ? {} : { view }), limit }
		}
		case "wait": {
			rejectFields(args, ["operation", "execution_ids", "mode", "timeout_ms"])
			const ids = args.execution_ids
			if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_EXECUTION_WAIT_TARGETS) {
				throw new Error(`execution_ids must contain 1–${MAX_EXECUTION_WAIT_TARGETS} execution IDs`)
			}
			if (ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error("execution_ids must contain nonblank strings")
			if (new Set(ids).size !== ids.length) throw new Error("execution_ids must be distinct")
			const mode = args.mode === undefined ? "any" : args.mode
			if (mode !== "any" && mode !== "all") throw new Error("mode must be any or all")
			const timeout_ms = args.timeout_ms === undefined ? undefined : requireInteger(args, "timeout_ms", 0, MAX_EXECUTION_WAIT_MS)
			return { operation: "wait", execution_ids: [...ids], mode, ...(timeout_ms === undefined ? {} : { timeout_ms }) }
		}
		case "cancel": {
			rejectFields(args, ["operation", "execution_id", "reason"])
			const execution_id = requireString(args, "execution_id")
			const reason = args.reason === undefined ? undefined : requireString(args, "reason")
			return { operation: "cancel", execution_id, ...(reason === undefined ? {} : { reason }) }
		}
		default:
			throw new Error("operation must be inspect, output, wait, or cancel")
	}
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key]
	if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a nonblank string`)
	return value
}

function requireInteger(args: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
	const value = args[key]
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${key} must be an integer from ${minimum} through ${maximum}`)
	}
	return value
}

function rejectFields(args: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(args)) {
		if (!allowed.includes(key)) throw new Error(`Parameter '${key}' is not valid for tool_executions ${args.operation}`)
	}
}
