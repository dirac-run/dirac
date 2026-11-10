import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { ToolExecutionRecord, ToolExecutionWorkOutcome } from "@shared/toolExecution"
import { TOOL_EXECUTION_INLINE_RESULT_BYTES } from "@shared/toolExecutionObservation"
import { createToolExecution, transitionToolExecution } from "./ToolExecution"
import { evaluateToolExecutionWait, projectToolExecution } from "./ToolExecutionObservation"

const owner = { rootTaskId: "root", taskId: "task", runId: "run" }
const context = { owner, observerExecutionId: "wait" }
function execution(executionId = "one"): ToolExecutionRecord {
	return createToolExecution({ executionId, owner, requestId: "request", nativeToolCallId: `call-${executionId}`, toolName: "read_file", toolSnapshot: { requestId: "request", inventoryVersion: 1 } }, { paths: ["large input"] })
}
function settle(record: ToolExecutionRecord, outcome: ToolExecutionWorkOutcome = { kind: "success", content: "done" }): ToolExecutionRecord {
	return transitionToolExecution(transitionToolExecution(record, { kind: "begin_settling", outcome }), { kind: "finish_settling", resourcesSettled: true })
}

describe("ToolExecutionObservation", () => {
	it("projects status without exposing arguments or internal delivery decisions", () => {
		assert.deepEqual(projectToolExecution(execution()), { identity: execution().identity, state: "queued", hasStarted: false, cancellationRequested: false })
	})

	it("preserves small image-bearing results without flattening", () => {
		const outcome: ToolExecutionWorkOutcome = { kind: "success", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] }
		assert.deepEqual(projectToolExecution(settle(execution(), outcome)).result, { kind: "inline", outcome })
	})

	it("references oversized full outcomes using actual UTF-8 bytes", () => {
		const outcome: ToolExecutionWorkOutcome = { kind: "failure", error: { code: "E", message: "😀".repeat(TOOL_EXECUTION_INLINE_RESULT_BYTES / 2) } }
		const projection = projectToolExecution(settle(execution(), outcome))
		assert.deepEqual(projection.result, { kind: "reference", execution_id: "one", outcome_kind: "failure", view: "result", utf8Bytes: Buffer.byteLength(JSON.stringify(outcome), "utf8") })
		assert.ok(JSON.stringify(projection).length < 1000)
	})

	it("returns undefined while waiting and never consumes target state", () => {
		const record = execution()
		const before = JSON.stringify(record)
		const request = { operation: "wait" as const, execution_ids: ["one"], mode: "any" as const }
		assert.equal(evaluateToolExecutionWait(request, [record], context), undefined)
		assert.equal(evaluateToolExecutionWait(request, [record], context), undefined)
		assert.equal(JSON.stringify(record), before)
	})

	it("observes completion before registration or at a later coherent snapshot identically", () => {
		const request = { operation: "wait" as const, execution_ids: ["one"], mode: "any" as const }
		const record = execution()
		assert.equal(evaluateToolExecutionWait(request, [record], context), undefined)
		const completed = settle(record)
		const result = evaluateToolExecutionWait(request, [completed], context)
		assert.equal(result?.status, "ready")
		assert.deepEqual(evaluateToolExecutionWait(request, [completed], context), result)
		assert.equal(completed.originalResponse, null)
		assert.equal(completed.completionEvent, null)
	})

	it("preserves request order and distinguishes any from all", () => {
		const one = execution()
		const two = settle(execution("two"))
		const request = { operation: "wait" as const, execution_ids: ["two", "one"], mode: "any" as const }
		assert.deepEqual(evaluateToolExecutionWait(request, [one, two], context)?.executions.map((item) => item.identity.executionId), ["two", "one"])
		assert.equal(evaluateToolExecutionWait({ ...request, mode: "all" }, [one, two], context), undefined)
		assert.equal(evaluateToolExecutionWait({ ...request, mode: "all" }, [settle(one), two], context)?.status, "ready")
	})

	it("all terminal outcomes satisfy waits; success is not inferred from a resolved wait", () => {
		const outcomes: ToolExecutionWorkOutcome[] = [
			{ kind: "success", content: "done" },
			{ kind: "failure", error: { code: "FAIL", message: "failed" } },
			{ kind: "cancelled", reason: "requested" },
			{ kind: "interrupted", reason: "reopened" },
		]
		for (const outcome of outcomes) {
			assert.equal(evaluateToolExecutionWait({ operation: "wait", execution_ids: ["one"], mode: "all" }, [settle(execution(), outcome)], context)?.status, "ready")
		}
	})

	it("wake signals end only the wait and settled targets win deadline races", () => {
		const request = { operation: "wait" as const, execution_ids: ["one"], mode: "all" as const }
		const record = execution()
		for (const wake of ["timeout", "user_input", "cancelled"] as const) {
			assert.equal(evaluateToolExecutionWait(request, [record], { ...context, wake })?.status, wake)
			assert.equal(record.cancellation, null)
			assert.equal(evaluateToolExecutionWait(request, [settle(record)], { ...context, wake })?.status, "ready")
		}
	})

	it("rejects self-wait, unknown targets, duplicate targets, and cross-run observation", () => {
		const request = { operation: "wait" as const, execution_ids: ["one"], mode: "any" as const }
		assert.throws(() => evaluateToolExecutionWait(request, [execution()], { ...context, observerExecutionId: "one" }), /itself/)
		assert.throws(() => evaluateToolExecutionWait(request, [], context), /Unknown/)
		assert.throws(() => evaluateToolExecutionWait({ ...request, execution_ids: ["one", "one"] }, [execution()], context), /distinct/)
		assert.throws(() => evaluateToolExecutionWait(request, [execution()], { ...context, owner: { ...owner, runId: "other" } }), /another owner/)
	})
})
