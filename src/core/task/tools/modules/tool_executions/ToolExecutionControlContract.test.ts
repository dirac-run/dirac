import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { normalizeOptionalToolParameters } from "../../runtime/normalizeOptionalToolParameters"
import {
    DEFAULT_EXECUTION_OUTPUT_BYTES,
    MAX_EXECUTION_OUTPUT_BYTES,
    MAX_EXECUTION_WAIT_MS,
    MAX_EXECUTION_WAIT_TARGETS,
    parseToolExecutionControl,
    tool_executions_spec,
} from "./ToolExecutionControlContract"

describe("tool_executions observation contract", () => {
	it("defines one shared control tool rather than per-tool execution modes", () => {
		assert.equal(tool_executions_spec.name, "tool_executions")
		assert.deepEqual(tool_executions_spec.parameters?.find((parameter) => parameter.name === "operation")?.enum,
			["inspect", "output", "wait", "cancel"])
	})

	it("parses non-consuming inspection and cancellation intent separately", () => {
		assert.deepEqual(parseToolExecutionControl({ operation: "inspect", execution_id: "e1" }), { operation: "inspect", execution_id: "e1" })
		assert.deepEqual(parseToolExecutionControl({ operation: "cancel", execution_id: "e1", reason: "No longer needed" }),
			{ operation: "cancel", execution_id: "e1", reason: "No longer needed" })
	})

	it("preserves target order and defaults to any settled target without a deadline", () => {
		const ids = ["e2", "e1"]
		const result = parseToolExecutionControl({ operation: "wait", execution_ids: ids })
		assert.deepEqual(result, { operation: "wait", execution_ids: ids, mode: "any" })
		assert.notEqual(result.operation === "wait" && result.execution_ids, ids)
	})

	it("allows an immediate check and an explicit all-target wait", () => {
		assert.deepEqual(parseToolExecutionControl({ operation: "wait", execution_ids: ["e1"], mode: "all", timeout_ms: 0 }),
			{ operation: "wait", execution_ids: ["e1"], mode: "all", timeout_ms: 0 })
	})

	it("bounds wait targets and rejects duplicates without silently changing semantics", () => {
		for (const execution_ids of [[], ["e1", "e1"], [""], [" "], [1], Array.from({ length: MAX_EXECUTION_WAIT_TARGETS + 1 }, (_, i) => `e${i}`)]) {
			assert.throws(() => parseToolExecutionControl({ operation: "wait", execution_ids }), /execution_ids/)
		}
		assert.doesNotThrow(() => parseToolExecutionControl({ operation: "wait", execution_ids: Array.from({ length: MAX_EXECUTION_WAIT_TARGETS }, (_, i) => `e${i}`) }))
	})

	it("accepts opaque output cursors and bounds UTF-8 payload budgets", () => {
		assert.deepEqual(parseToolExecutionControl({ operation: "output", execution_id: "e1" }),
			{ operation: "output", execution_id: "e1", limit: DEFAULT_EXECUTION_OUTPUT_BYTES })
		assert.deepEqual(parseToolExecutionControl({ operation: "output", execution_id: "e1", cursor: "opaque:1", limit: MAX_EXECUTION_OUTPUT_BYTES }),
			{ operation: "output", execution_id: "e1", cursor: "opaque:1", limit: MAX_EXECUTION_OUTPUT_BYTES })
	})

	it("rejects wrong-operation fields rather than ignoring them", () => {
		for (const input of [
			{ operation: "inspect", execution_id: "e1", timeout_ms: 1 },
			{ operation: "cancel", execution_id: "e1", mode: "all" },
			{ operation: "output", execution_id: "e1", execution_ids: ["e1"] },
			{ operation: "wait", execution_ids: ["e1"], execution_id: "e1" },
		]) assert.throws(() => parseToolExecutionControl(input), /not valid/)
	})

	it("rejects invalid scalar values, operations, and shapes", () => {
		for (const input of [null, [], "inspect", {}, { operation: "start" }]) assert.throws(() => parseToolExecutionControl(input))
		for (const execution_id of [undefined, null, "", " ", 1]) {
			assert.throws(() => parseToolExecutionControl({ operation: "inspect", execution_id }), /execution_id/)
		}
		for (const timeout_ms of [-1, 0.5, Infinity, NaN, "1", null, MAX_EXECUTION_WAIT_MS + 1]) {
			assert.throws(() => parseToolExecutionControl({ operation: "wait", execution_ids: ["e1"], timeout_ms }), /timeout_ms/)
		}
		for (const limit of [0, -1, 1.5, MAX_EXECUTION_OUTPUT_BYTES + 1]) {
			assert.throws(() => parseToolExecutionControl({ operation: "output", execution_id: "e1", limit }), /limit/)
		}
		assert.throws(() => parseToolExecutionControl({ operation: "wait", execution_ids: ["e1"], mode: "first" }), /mode/)
	})

	it("uses the common normalization for provider-required optional null fields", () => {
		const args = normalizeOptionalToolParameters({ operation: "inspect", execution_id: "e1", execution_ids: null, mode: null, timeout_ms: null, cursor: null, limit: null, reason: null }, tool_executions_spec)
		assert.deepEqual(parseToolExecutionControl(args), { operation: "inspect", execution_id: "e1" })
	})
})
