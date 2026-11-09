import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import {
    formatTaskletReceipt,
    taskletReceiptTitle,
    type TaskletReceipt,
    type TaskletReceiptOperation,
    type TaskletReceiptOutcome,
} from "./taskletReceipt"

function receipt(operation: TaskletReceiptOperation, outcome: TaskletReceiptOutcome = "resolved"): TaskletReceipt {
	return { operation, outcome, rows: [{ operation, outcome, taskletId: "Planck", title: "Review code", role: "Reviewer" }] }
}

describe("Tasklet communication receipts", () => {
	it("keeps actor and recipient compact without assignment titles or roles", () => {
		for (const [operation, label] of [["guidance", "Guidance"], ["reply", "Answer"], ["spawn", "Start agents"], ["resume", "Resume"], ["inspect", "Inspect status"]] as const) {
			assert.equal(taskletReceiptTitle(receipt(operation), "Feynman"), `Feynman → Planck · ${label}`)
		}
		assert.equal(taskletReceiptTitle(receipt("list", "retrieved"), "Dirac"), "Dirac · Agents")
	})

	it("puts requested, failed and stale state in the body rather than claiming completion", () => {
		for (const outcome of ["requested", "failed", "stale", "already_resolved"] as const) {
			const item = receipt("reply", outcome)
			assert.equal(taskletReceiptTitle(item, "Dirac"), "Dirac → Planck · Answer")
			assert.match(formatTaskletReceipt(item, true), new RegExp(`Status: ${outcome === "already_resolved" ? "Already resolved" : outcome === "stale" ? "Stale request" : outcome[0].toUpperCase() + outcome.slice(1)}`))
		}
	})

	it("retains exact guidance and reply content as well as admission failures", () => {
		const guidance = receipt("guidance", "failed")
		guidance.rows[0].message = "  Preserve whitespace\n\nUnicode ✓\n"
		guidance.rows[0].error = "Admission failed"
		guidance.error = "Batch failed"
		const body = formatTaskletReceipt(guidance, true)
		assert.ok(body.startsWith(guidance.rows[0].message))
		assert.match(body, /Status: Failed/)
		assert.match(body, /Error: Operation failed/)
		assert.doesNotMatch(body, /Admission failed|Batch failed/)
		const reply = receipt("reply")
		reply.rows[0].message = "The exact response."
		reply.rows[0].choice = "Exact choice"
		assert.ok(formatTaskletReceipt(reply, true).startsWith("The exact response.\n\nChoice: Exact choice"))
		delete reply.rows[0].message
		assert.ok(formatTaskletReceipt(reply, true).startsWith("Choice: Exact choice"))
	})

	for (const decision of ["approve", "reject", "escalate"] as const) {
		it(`retains scoped ${decision} decisions without fabricating escalation or authority`, () => {
			const permission = receipt("permission_decision", "requires_user_approval")
			permission.rows[0].decision = decision
			permission.rows[0].requestId = "opaque-permission-id"
			assert.equal(taskletReceiptTitle(permission, "Dirac"), "Dirac → Planck · Permission decision")
			let content = formatTaskletReceipt(permission, true)
			assert.match(content, new RegExp(`Decision: ${decision}`))
			assert.doesNotMatch(content, /opaque-permission-id/)
			assert.match(content, /did not grant permission or initiate user escalation/)
			permission.outcome = permission.rows[0].outcome = "requested"
			assert.match(formatTaskletReceipt(permission, true), /decision attempt is not a permission grant/)
			permission.outcome = permission.rows[0].outcome = "resolved"
			content = formatTaskletReceipt(permission, true)
			assert.match(content, decision === "escalate" ? /User escalation resolved/ : /This request only, within parent authority/)
			permission.outcome = permission.rows[0].outcome = "already_resolved"
			assert.match(formatTaskletReceipt(permission, true), /Status: Already resolved/)
		})
	}

	it("formats an empty or populated roster rather than serialized JSON", () => {
		const list = receipt("list", "retrieved")
		list.returnedCount = list.totalCount = 1
		list.rows[0].observedState = "waiting_for_parent"
		assert.equal(formatTaskletReceipt(list, true), "Planck (Reviewer) — Review code — Waiting for parent\n\n1 of 1 items · passive read")
		list.rows = []
		list.returnedCount = list.totalCount = 0
		assert.equal(formatTaskletReceipt(list, true), "No subagents found.\n\n0 of 0 items · passive read")
	})

	it("describes sleep scope, wake and cancellation without child completion claims", () => {
		const sleep: TaskletReceipt = {
			operation: "sleep", outcome: "requested", rows: [], waitScope: "selected_tasklets", waitSourceIds: ["Planck", "Curie"], waitSourceCount: 2,
		}
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac · Awaiting agents")
		assert.match(formatTaskletReceipt(sleep, true), /Waiting for communication from 2 selected agents/)
		sleep.outcome = "woke"
		sleep.wakeReason = "event"
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac · Wait ended")
		assert.match(formatTaskletReceipt(sleep, true), /A wake is not assignment completion/)
		sleep.outcome = "cancelled"
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac · Wait ended")
	})
})
