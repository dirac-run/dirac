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
	return {
		operation,
		outcome,
		rows: [{ operation, outcome, taskletId: "Planck", title: "Review code", role: "Reviewer" }],
	}
}

describe("Tasklet action/content receipts", () => {
	it("uses actor/action/stable-child headers while retaining legacy receipt titles", () => {
		const guidance = receipt("guidance", "queued")
		assert.equal(taskletReceiptTitle(guidance, "Dirac"), "Dirac sent guidance to Planck (Reviewer) — Review code")
		assert.equal(taskletReceiptTitle(guidance), "Send guidance · Planck (Reviewer) — Review code")
		assert.equal(taskletReceiptTitle(receipt("list", "retrieved"), "Dirac"), "Dirac listed subagents")
		assert.equal(taskletReceiptTitle(receipt("spawn", "accepted"), "Dirac"), "Dirac started Planck (Reviewer) — Review code")
		assert.equal(taskletReceiptTitle(receipt("resume", "accepted"), "Dirac"), "Dirac resumed Planck (Reviewer) — Review code")
	})

	it("does not present requested or failed operations as completed actions", () => {
		for (const [operation, ongoing, failure] of [
			["guidance", "is sending guidance", "failed to send guidance"],
			["reply", "is replying", "failed to reply"],
			["spawn", "is starting", "failed to start"],
			["inspect", "is inspecting", "failed to inspect"],
			["resume", "is resuming", "failed to resume"],
			["interrupt", "is interrupting", "failed to interrupt"],
			["list", "is listing", "failed to list"],
		] as const) {
			assert.ok(taskletReceiptTitle(receipt(operation, "requested"), "Dirac").includes(ongoing))
			assert.ok(taskletReceiptTitle(receipt(operation, "failed"), "Dirac").includes(failure))
		}
		assert.match(taskletReceiptTitle(receipt("reply", "stale"), "Dirac"), /failed to reply/)
	})

	it("keeps guidance and reply content exact only for communication cards", () => {
		const guidance = receipt("guidance", "failed")
		guidance.rows[0].message = "  Preserve whitespace\n\nUnicode ✓\n"
		guidance.rows[0].error = "Admission failed"
		guidance.error = "Batch failed"
		assert.equal(formatTaskletReceipt(guidance, true), guidance.rows[0].message)
		const legacy = formatTaskletReceipt(guidance)
		assert.match(legacy, /Error: Admission failed/)
		assert.match(legacy, /Error: Batch failed/)
		const reply = receipt("reply")
		reply.rows[0].message = "The exact response."
		reply.rows[0].choice = "Exact choice"
		assert.equal(formatTaskletReceipt(reply, true), "The exact response.\nExact choice")
		delete reply.rows[0].message
		assert.equal(formatTaskletReceipt(reply, true), "Exact choice")
	})

	for (const [decision, completed] of [
		["approve", "approved"],
		["reject", "rejected"],
		["escalate", "escalated"],
	] as const) {
		it(`shows ${decision} for only the addressed request without fabricating authority`, () => {
			const permission = receipt("permission_decision")
			permission.rows[0].decision = decision
			permission.rows[0].requestId = "opaque-permission-id"
			assert.equal(taskletReceiptTitle(permission, "Dirac"), `Dirac ${completed} Planck's request`)
			assert.doesNotMatch(taskletReceiptTitle(permission, "Dirac"), /opaque-permission-id/)
			const content = formatTaskletReceipt(permission, true)
			assert.match(content, new RegExp(`^Decision: ${decision}\\nRequest: opaque-permission-id\\n`))
			assert.match(
				content,
				decision === "escalate"
					? /does not grant permission; user approval is still required/
					: /This request only, within parent authority/,
			)
			permission.outcome = permission.rows[0].outcome = "requires_user_approval"
			assert.equal(taskletReceiptTitle(permission, "Dirac"), "Dirac requested user approval for Planck's request")
			assert.match(formatTaskletReceipt(permission, true), /this decision did not grant permission/)
			permission.outcome = permission.rows[0].outcome = "already_resolved"
			assert.equal(taskletReceiptTitle(permission, "Dirac"), "Dirac found Planck's request already resolved")
			permission.outcome = permission.rows[0].outcome = "failed"
			assert.equal(taskletReceiptTitle(permission, "Dirac"), `Dirac failed to ${decision} Planck's request`)
			permission.rows[0].error = "Authority changed"
			permission.error = "Host failed"
			assert.match(formatTaskletReceipt(permission), /Error: Authority changed/)
			assert.match(formatTaskletReceipt(permission), /Error: Host failed/)
		})
	}

	it("formats an empty or populated roster rather than serialized JSON", () => {
		const list = receipt("list", "retrieved")
		list.returnedCount = list.totalCount = 1
		list.rows[0].observedState = "waiting_for_parent"
		assert.equal(
			formatTaskletReceipt(list, true),
			"Planck (Reviewer) — Review code — Waiting for parent\n\n1 of 1 items · passive read",
		)
		list.rows = []
		list.returnedCount = list.totalCount = 0
		assert.equal(formatTaskletReceipt(list, true), "No subagents found.\n\n0 of 0 items · passive read")
	})

	it("describes sleep scope, wake and cancellation without child completion claims", () => {
		const sleep: TaskletReceipt = {
			operation: "sleep",
			outcome: "requested",
			rows: [],
			waitScope: "selected_tasklets",
			waitSourceIds: ["Planck", "Curie"],
			waitSourceCount: 2,
		}
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac is waiting for Planck, Curie")
		sleep.outcome = "woke"
		sleep.wakeReason = "event"
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac waited for Planck, Curie")
		assert.match(formatTaskletReceipt(sleep, true), /A wake is not assignment completion/)
		sleep.outcome = "cancelled"
		assert.equal(taskletReceiptTitle(sleep, "Dirac"), "Dirac's wait for Planck, Curie was cancelled")
	})
})
