import assert from "node:assert/strict"
import { describe, it } from "mocha"
import type { DiracToolResponseContent } from "@shared/messages/content"
import type {
	ToolExecutionCommand,
	ToolExecutionIdentity,
	ToolExecutionRecord,
	ToolExecutionState,
	ToolExecutionWorkOutcome,
} from "@shared/toolExecution"
import {
	chooseToolExecutionResponse,
	claimToolExecutionCompletion,
	createToolExecution,
	inspectToolExecution,
	ToolExecutionTransitionError,
	transitionToolExecution,
} from "./ToolExecution"

const identity: ToolExecutionIdentity = {
	executionId: "execution-1",
	owner: { rootTaskId: "root-1", taskId: "task-1", runId: "run-1" },
	requestId: "request-1",
	nativeToolCallId: "call-1",
	toolName: "read_file",
	toolSnapshot: { requestId: "request-1", inventoryVersion: 2, configurationRevision: 3 },
}
const success: ToolExecutionWorkOutcome = { kind: "success", content: "complete" }
const error = { code: "CLEANUP_FAILED", message: "Resource still alive" }
const cancel: ToolExecutionCommand = {
	kind: "request_cancel",
	cancellation: { requestedBy: identity.owner, requestedAt: 10, reason: "Stop" },
}

function create(): ToolExecutionRecord {
	return createToolExecution(identity, { path: "src/index.ts" })
}

function settle(record: ToolExecutionRecord, outcome: ToolExecutionWorkOutcome = success): ToolExecutionRecord {
	const settling = transitionToolExecution(record, { kind: "begin_settling", outcome })
	return transitionToolExecution(settling, { kind: "finish_settling", resourcesSettled: true })
}

const states: readonly ToolExecutionState[] = [
	{ kind: "queued" },
	{ kind: "running" },
	{ kind: "waiting_permission", permissionRequestId: "permission-1" },
	{ kind: "waiting_resource", resourceId: "resource-1" },
	{ kind: "waiting_input", inputRequestId: "input-1" },
	{ kind: "settling", operationOutcome: success },
	{ kind: "terminal", outcome: success },
]

const transitionCases: readonly {
	command: ToolExecutionCommand
	allowed: readonly ToolExecutionState["kind"][]
}[] = [
		{ command: { kind: "start" }, allowed: ["queued"] },
		{ command: { kind: "wait", waiting: { kind: "waiting_permission", permissionRequestId: "p" } }, allowed: ["queued", "running", "waiting_permission", "waiting_resource", "waiting_input"] },
		{ command: { kind: "wait", waiting: { kind: "waiting_resource", resourceId: "r" } }, allowed: ["queued", "running", "waiting_permission", "waiting_resource", "waiting_input"] },
		{ command: { kind: "wait", waiting: { kind: "waiting_input", inputRequestId: "i" } }, allowed: ["queued", "running", "waiting_permission", "waiting_resource", "waiting_input"] },
		{ command: { kind: "resume" }, allowed: ["waiting_permission", "waiting_resource", "waiting_input"] },
		{ command: { kind: "begin_settling", outcome: success }, allowed: ["queued", "running", "waiting_permission", "waiting_resource", "waiting_input"] },
		{ command: { kind: "record_settlement_failure", error }, allowed: ["settling"] },
		{ command: { kind: "finish_settling", resourcesSettled: true }, allowed: ["settling"] },
	]

describe("ToolExecution pure lifecycle", () => {
	it("pins the owner, request, native call, snapshot and copied admission arguments", () => {
		const args = { paths: ["first.ts"], options: { recursive: true } }
		const record = createToolExecution(identity, args)
		args.paths.push("second.ts")
		args.options.recursive = false
		assert.deepEqual(record.arguments, { paths: ["first.ts"], options: { recursive: true } })
		assert.deepEqual(record.identity, identity)
		assert.notEqual(record.identity, identity)
		assert.equal(record.revision, 0)
		assert.equal(record.hasStarted, false)
		assert.equal(record.state.kind, "queued")
		assert.throws(() => createToolExecution({ ...identity, requestId: "other" }, {}), /originating request/)
		assert.equal(createToolExecution({ ...identity, nativeToolCallId: null }, {}).identity.nativeToolCallId, null)
	})

	for (const state of states) {
		for (const { command, allowed } of transitionCases) {
			it(`${state.kind} + ${command.kind}${command.kind === "wait" ? `:${command.waiting.kind}` : ""} is ${allowed.includes(state.kind) ? "legal" : "rejected"}`, () => {
				const record = Object.freeze({ ...create(), state: Object.freeze(state) })
				if (!allowed.includes(state.kind)) {
					assert.throws(() => transitionToolExecution(record, command), ToolExecutionTransitionError)
					return
				}
				const next = transitionToolExecution(record, command)
				assert.equal(next.revision, record.revision + 1)
				assert.equal(record.state, state)
				assert.notEqual(next, record)
				assert.equal(next.identity, record.identity)
			})
		}
	}

	it("distinguishes a pre-start wait from a wait after entering running", () => {
		const queued = create()
		const preStart = transitionToolExecution(queued, { kind: "wait", waiting: { kind: "waiting_permission", permissionRequestId: "p" } })
		assert.equal(preStart.hasStarted, false)
		const running = transitionToolExecution(preStart, { kind: "resume" })
		assert.equal(running.hasStarted, true)
		const suspended = transitionToolExecution(running, { kind: "wait", waiting: { kind: "waiting_input", inputRequestId: "i" } })
		assert.equal(suspended.hasStarted, true)
		assert.equal(settle(suspended).hasStarted, true)
		assert.equal(settle(queued, { kind: "cancelled", reason: "Before start" }).hasStarted, false)
	})

	for (const state of states) {
		it(`cancellation in ${state.kind} is intent only, first-wins, and a terminal no-op`, () => {
			const record = { ...create(), state }
			const requested = transitionToolExecution(record, cancel)
			assert.equal(requested.state, record.state)
			if (state.kind === "terminal") {
				assert.equal(requested, record)
				assert.equal(requested.cancellation, null)
				return
			}
			assert.deepEqual(requested.cancellation, cancel.kind === "request_cancel" ? cancel.cancellation : null)
			assert.equal(requested.revision, record.revision + 1)
			assert.equal(transitionToolExecution(requested, {
				kind: "request_cancel", cancellation: { requestedBy: identity.owner, requestedAt: 20, reason: "Different" },
			}), requested)
		})
	}

	it("does not infer outcome kinds from content or cancellation intent", () => {
		const requested = transitionToolExecution(create(), cancel)
		const terminal = settle(requested, { kind: "success", content: "cancelled failure interrupted" })
		assert.equal(terminal.state.kind, "terminal")
		if (terminal.state.kind !== "terminal") assert.fail("Expected terminal")
		assert.equal(terminal.state.outcome.kind, "success")
		assert.notEqual(terminal.cancellation, null)
	})

	it("retains every structured operation outcome when settlement fails", () => {
		const outcomes: readonly ToolExecutionWorkOutcome[] = [
			success,
			{ kind: "failure", error: { code: "EXECUTION_FAILED", message: "Operation failed" } },
			{ kind: "cancelled", reason: "Owner cancellation acknowledged" },
			{ kind: "interrupted", reason: "Runtime lost" },
		]
		for (const outcome of outcomes) {
			const settling = transitionToolExecution(create(), { kind: "begin_settling", outcome })
			const failed = transitionToolExecution(settling, { kind: "finish_settling", resourcesSettled: true, settlementError: error })
			assert.deepEqual(failed.state, { kind: "terminal", outcome: { kind: "settlement_failed", error, operationOutcome: outcome } })
		}
	})

	it("keeps failed cleanup settling until resources are actually relinquished", () => {
		const accepted = chooseToolExecutionResponse(create(), "Accepted").record
		const settling = transitionToolExecution(accepted, { kind: "begin_settling", outcome: success })
		const cleanupFailed = transitionToolExecution(settling, { kind: "record_settlement_failure", error })
		assert.deepEqual(cleanupFailed.state, { kind: "settling", operationOutcome: success, settlementError: error })
		assert.equal(claimToolExecutionCompletion(cleanupFailed).event, undefined)
		assert.throws(() => transitionToolExecution(cleanupFailed, {
			kind: "finish_settling", resourcesSettled: false,
		} as unknown as ToolExecutionCommand), ToolExecutionTransitionError)
		const recovered = transitionToolExecution(cleanupFailed, { kind: "finish_settling", resourcesSettled: true })
		assert.deepEqual(recovered.state, { kind: "terminal", outcome: success })
	})

	it("preserves multimodal response blocks without converting them to strings", () => {
		const content: DiracToolResponseContent = [
			{ type: "text", text: "Image result" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
		]
		const terminal = settle(create(), { kind: "success", content })
		const decision = chooseToolExecutionResponse(terminal, "Not used")
		assert.deepEqual(decision.response, { kind: "settled", executionId: identity.executionId, outcome: { kind: "success", content } })
	})
})

describe("ToolExecution response arbitration", () => {
	for (const state of states) {
		it(`response commit in ${state.kind} requires a chosen response and is idempotent`, () => {
			const record = { ...create(), state }
			assert.throws(() => transitionToolExecution(record, { kind: "mark_response_committed" }), ToolExecutionTransitionError)
			const chosen = chooseToolExecutionResponse(record, "Accepted").record
			assert.equal(chosen.originalResponseCommitted, false)
			const committed = transitionToolExecution(chosen, { kind: "mark_response_committed" })
			assert.equal(committed.originalResponseCommitted, true)
			assert.equal(committed.revision, chosen.revision + 1)
			assert.equal(committed.state, chosen.state)
			assert.equal(transitionToolExecution(committed, { kind: "mark_response_committed" }), committed)
		})
	}

	it("snapshots caller-owned decision payloads so revisions cannot change through aliases", () => {
		const acceptance = [{ type: "text" as const, text: "Original acceptance" }]
		const accepted = chooseToolExecutionResponse(create(), acceptance).record
		acceptance[0].text = "Mutated acceptance"
		assert.deepEqual(accepted.originalResponse, { kind: "accepted", executionId: identity.executionId, content: [{ type: "text", text: "Original acceptance" }] })
		const cancellation = { requestedBy: { ...identity.owner }, requestedAt: 5, reason: "Original cancellation" }
		const cancelled = transitionToolExecution(accepted, { kind: "request_cancel", cancellation })
		cancellation.reason = "Mutated cancellation"
		cancellation.requestedBy.runId = "mutated run"
		assert.equal(cancelled.cancellation?.reason, "Original cancellation")
		assert.equal(cancelled.cancellation?.requestedBy.runId, identity.owner.runId)
		const waiting = { kind: "waiting_input" as const, inputRequestId: "original input" }
		const suspended = transitionToolExecution(cancelled, { kind: "wait", waiting })
		waiting.inputRequestId = "mutated input"
		assert.deepEqual(suspended.state, { kind: "waiting_input", inputRequestId: "original input" })
		const content = [{ type: "text" as const, text: "Original result" }]
		const outcome = { kind: "success" as const, content }
		const settling = transitionToolExecution(suspended, { kind: "begin_settling", outcome })
		content[0].text = "Mutated result"
		const cleanupError = { code: "ORIGINAL", message: "Original error" }
		const cleanupFailed = transitionToolExecution(settling, { kind: "record_settlement_failure", error: cleanupError })
		cleanupError.message = "Mutated error"
		assert.deepEqual(cleanupFailed.state, { kind: "settling", operationOutcome: { kind: "success", content: [{ type: "text", text: "Original result" }] }, settlementError: { code: "ORIGINAL", message: "Original error" } })
		const finalError = { code: "FINAL", message: "Final error" }
		const terminal = transitionToolExecution(cleanupFailed, { kind: "finish_settling", resourcesSettled: true, settlementError: finalError })
		const committed = transitionToolExecution(terminal, { kind: "mark_response_committed" })
		const claimed = claimToolExecutionCompletion(committed)
		finalError.message = "Mutated final error"
		assert.deepEqual(claimed.event?.outcome, { kind: "settlement_failed", error: { code: "FINAL", message: "Final error" }, operationOutcome: { kind: "success", content: [{ type: "text", text: "Original result" }] } })
	})

	it("chooses settled result if terminal first, with no completion event", () => {
		const terminal = settle(create())
		assert.equal(claimToolExecutionCompletion(terminal).event, undefined)
		const chosen = chooseToolExecutionResponse(terminal, "Accepted")
		assert.equal(chosen.newlyChosen, true)
		assert.equal(chosen.response.kind, "settled")
		assert.equal(chosen.record.revision, terminal.revision + 1)
		const repeated = chooseToolExecutionResponse(chosen.record, "Different acceptance")
		assert.equal(repeated.record, chosen.record)
		assert.equal(repeated.response, chosen.response)
		assert.equal(repeated.newlyChosen, false)
		assert.equal(claimToolExecutionCompletion(chosen.record).event, undefined)
	})

	for (const state of states.filter((state) => state.kind !== "terminal")) {
		it(`chooses acceptance in ${state.kind}, then exactly one completion decision`, () => {
			const record = { ...create(), state }
			const accepted = chooseToolExecutionResponse(record, "Accepted original")
			assert.equal(accepted.response.kind, "accepted")
			assert.equal(claimToolExecutionCompletion(accepted.record).event, undefined)
			const terminal = state.kind === "settling"
				? transitionToolExecution(accepted.record, { kind: "finish_settling", resourcesSettled: true })
				: settle(accepted.record)
			const repeatedResponse = chooseToolExecutionResponse(terminal, "Must not replace acceptance")
			assert.equal(repeatedResponse.response, accepted.response)
			assert.equal(repeatedResponse.newlyChosen, false)
			assert.equal(claimToolExecutionCompletion(terminal).event, undefined)
			const committed = transitionToolExecution(terminal, { kind: "mark_response_committed" })
			const claimed = claimToolExecutionCompletion(committed)
			assert.equal(claimed.newlyChosen, true)
			assert.equal(claimed.record.revision, committed.revision + 1)
			assert.deepEqual(claimed.event?.outcome, success)
			const repeatedClaim = claimToolExecutionCompletion(claimed.record)
			assert.equal(repeatedClaim.record, claimed.record)
			assert.equal(repeatedClaim.event, claimed.event)
			assert.equal(repeatedClaim.newlyChosen, false)
		})
	}

	it("completion keys are stable, unambiguous and scoped to root/task/run/execution", () => {
		function eventId(overrides: Partial<ToolExecutionIdentity>): string | undefined {
			const accepted = chooseToolExecutionResponse(createToolExecution({ ...identity, ...overrides }, {}), "Accepted")
			const committed = transitionToolExecution(accepted.record, { kind: "mark_response_committed" })
			return claimToolExecutionCompletion(settle(committed)).event?.eventId
		}
		const first = eventId({})
		assert.equal(eventId({}), first)
		for (const key of ["rootTaskId", "taskId", "runId"] as const) {
			assert.notEqual(eventId({ owner: { ...identity.owner, [key]: "different" } }), first)
		}
		assert.notEqual(eventId({ executionId: "different" }), first)
		assert.notEqual(eventId({ owner: { ...identity.owner, taskId: "a:b", runId: "c" } }), eventId({ owner: { ...identity.owner, taskId: "a", runId: "b:c" } }))
	})

	it("inspect is nonconsuming before choice, after acceptance, and after completion", () => {
		const queued = Object.freeze(create())
		assert.equal(inspectToolExecution(queued), queued)
		assert.equal(queued.originalResponse, null)
		const accepted = Object.freeze(chooseToolExecutionResponse(queued, "Accepted").record)
		assert.equal(inspectToolExecution(accepted), accepted)
		assert.equal(accepted.completionEvent, null)
		const committed = transitionToolExecution(accepted, { kind: "mark_response_committed" })
		const completed = Object.freeze(claimToolExecutionCompletion(settle(committed)).record)
		assert.equal(inspectToolExecution(completed), completed)
		assert.equal(inspectToolExecution(completed), inspectToolExecution(completed))
		assert.notEqual(completed.completionEvent, null)
	})
})
