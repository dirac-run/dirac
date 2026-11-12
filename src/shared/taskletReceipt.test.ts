import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import {
	formatTaskletReceipt,
	taskletReceiptNote,
	taskletReceiptTitle,
	type TaskletReceipt,
	type TaskletReceiptOperation,
	type TaskletReceiptOutcome,
} from "./taskletReceipt"

function receipt(operation: TaskletReceiptOperation, outcome: TaskletReceiptOutcome = "resolved"): TaskletReceipt {
	return { operation, outcome, rows: [{ operation, outcome, taskletId: "Planck", title: "Review code", role: "Reviewer" }] }
}

describe("Tasklet communication receipts", () => {
	it("keeps actor and recipient compact with roles but without assignment titles", () => {
		for (const [operation, label] of [["guidance", "Guidance"], ["reply", "Answer"], ["spawn", "Start agents"], ["resume", "Resume"], ["inspect", "Inspect status"]] as const) {
			assert.equal(taskletReceiptTitle(receipt(operation), "Feynman"), `Feynman → Planck [Reviewer] · ${label}`)
			assert.equal(taskletReceiptTitle(receipt(operation), "Feynman", "Coder"), `Feynman [Coder] → Planck [Reviewer] · ${label}`)
		}
		assert.equal(taskletReceiptTitle(receipt("list", "retrieved"), "Dirac"), "Dirac · Agents")
	})

	it("suppresses default and Dirac roles in actor and recipient labels", () => {
		for (const role of ["default", "DeFaUlT", "", undefined]) {
			const item = receipt("message", "queued")
			item.rows[0].role = role
			assert.equal(taskletReceiptTitle(item, "Feynman", role), "Feynman → Planck · Messages")
			assert.equal(taskletReceiptTitle(item), "Message agents · Planck")
		}
		const item = receipt("message", "queued")
		item.rows[0].taskletId = "Dirac"
		assert.equal(taskletReceiptTitle(item, "Dirac", "Coder"), "Dirac → Dirac · Messages")
		assert.equal(taskletReceiptTitle(item), "Message agents · Dirac")
	})

	it("formats individual recipients without changing raw routing IDs or aggregate counts", () => {
		const item = receipt("message", "queued")
		assert.equal(taskletReceiptTitle(item), "Message agents · Planck [Reviewer]")
		assert.equal(taskletReceiptTitle(item, "Dirac", "Coder"), "Dirac → Planck [Reviewer] · Messages")
		item.rows.push({ ...item.rows[0] })
		assert.equal(taskletReceiptTitle(item, "Dirac"), "Dirac → Planck [Reviewer] · Messages")
		item.rows.push({ ...item.rows[0], taskletId: "Curie", role: "Coder" })
		assert.equal(taskletReceiptTitle(item, "Dirac"), "Dirac → 2 agents · Messages")
		assert.deepEqual(item.rows.map((row) => row.taskletId), ["Planck", "Planck", "Curie"])
	})

	it("retains outcome status in exports without duplicating communication metadata", () => {
		for (const outcome of ["requested", "failed", "stale", "already_resolved"] as const) {
			const item = receipt("reply", outcome)
			assert.equal(taskletReceiptTitle(item, "Dirac"), "Dirac → Planck [Reviewer] · Answer")
			assert.match(formatTaskletReceipt(item), new RegExp(`Status: ${outcome === "already_resolved" ? "Already resolved" : outcome === "stale" ? "Stale request" : outcome[0].toUpperCase() + outcome.slice(1)}`))
			assert.equal(formatTaskletReceipt(item, true), "")
		}
	})

	it("retains exact guidance and reply content as well as admission failures", () => {
		const guidance = receipt("guidance", "failed")
		guidance.rows[0].message = "  Preserve whitespace\n\nUnicode ✓\n"
		guidance.rows[0].error = "Admission failed"
		guidance.error = "Batch failed"
		const body = formatTaskletReceipt(guidance, true)
		assert.ok(body.startsWith(guidance.rows[0].message))
		assert.doesNotMatch(body, /Status:|Send guidance/)
		assert.equal(body.match(/Error: Operation failed/g)?.length, 1)
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
			assert.equal(taskletReceiptTitle(permission, "Dirac"), "Dirac → Planck [Reviewer] · Permission decision")
			let content = formatTaskletReceipt(permission, true)
			assert.match(content, new RegExp(`Requested decision: ${decision}`))
			assert.doesNotMatch(content, /opaque-permission-id/)
			assert.match(content, /User approval required; permission not granted\./)
			permission.outcome = permission.rows[0].outcome = "requested"
			assert.equal(formatTaskletReceipt(permission, true), `Requested decision: ${decision}`)
			permission.outcome = permission.rows[0].outcome = "resolved"
			content = formatTaskletReceipt(permission, true)
			assert.equal(content, `Requested decision: ${decision}${decision === "escalate" ? "\n\nUser escalation resolved." : ""}`)
			assert.doesNotMatch(content, /Approved|Rejected|permission granted/)
			permission.outcome = permission.rows[0].outcome = "already_resolved"
			assert.match(formatTaskletReceipt(permission), /Status: Already resolved/)
		})
	}

	it("formats an empty or populated roster rather than serialized JSON", () => {
		const list = receipt("list", "retrieved")
		list.returnedCount = list.totalCount = 1
		list.rows[0].observedState = "waiting_for_parent"
		assert.equal(formatTaskletReceipt(list, true), "Planck [Reviewer] — Review code — Waiting for parent\n\n1 of 1 items")
		list.hasMore = true
		assert.match(formatTaskletReceipt(list, true), /1 of 1 items · more available/)
		list.hasMore = false
		list.rows = []
		list.returnedCount = list.totalCount = 0
		assert.equal(formatTaskletReceipt(list, true), "No subagents found.\n\n0 of 0 items")
	})

	it("describes sleep scope, wake and cancellation without child completion claims", () => {
		const sleep: TaskletReceipt = {
			operation: "sleep", outcome: "requested", rows: [], waitScope: "selected_tasklets", waitSourceIds: ["Planck", "Curie"], waitSourceCount: 2,
		}
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac · Awaiting agents")
		assert.equal(formatTaskletReceipt(sleep, true), "Waiting for messages from 2 agents.\n\nAgents: Planck, Curie")
		sleep.outcome = "woke"
		sleep.wakeReason = "event"
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac · Wait ended")
		assert.equal(formatTaskletReceipt(sleep, true), "Agent update received.\n\nAgents: Planck, Curie")
		sleep.outcome = "cancelled"
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac · Wait ended")
		assert.equal(taskletReceiptNote(sleep), "Wait cancelled.")
	})

	it("formats a named sleep source from saved row metadata without modifying wait IDs", () => {
		const sleep = receipt("sleep", "requested")
		sleep.waitScope = "selected_tasklets"
		sleep.waitSourceIds = ["Planck"]
		assert.equal(taskletReceiptTitle(sleep, "Feynman", "Coder"), "Feynman [Coder] · Awaiting Planck [Reviewer]")
		assert.deepEqual(sleep.waitSourceIds, ["Planck"])
	})

	it("uses concise wake reasons and leaves ordinary acceptance to the status label", () => {
		for (const [wakeReason, note] of [
			["mail", "Agent message received."],
			["journal", "Journal notification received."],
			["timeout", "Deadline reached."],
			["user_message", "User input received."],
			["cancelled", "Wait cancelled."],
		] as const) {
			assert.equal(taskletReceiptNote({ operation: "sleep", outcome: "woke", rows: [], wakeReason }), note)
		}
		for (const operation of ["spawn", "resume", "guidance"] as const) {
			assert.equal(taskletReceiptNote(receipt(operation, operation === "guidance" ? "queued" : "accepted")), undefined)
		}
		assert.equal(taskletReceiptNote({ operation: "sleep", outcome: "failed", rows: [] }), "Wait failed.")
		assert.equal(taskletReceiptNote({ operation: "sleep", outcome: "requested", rows: [], waitScope: "any_tasklet" }), "Waiting for agent messages.")
		assert.equal(taskletReceiptNote({ operation: "sleep", outcome: "requested", rows: [], waitScope: "time_or_user" }), "Waiting for timeout or user input.")
	})
})
