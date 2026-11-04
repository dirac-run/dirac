import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { GoalRecord } from "@shared/goal"
import { calculateGoalAccounting, replaceGoalAccountingSource } from "../GoalAccounting"

function record(): GoalRecord {
	return {
		version: 2,
		id: "goal",
		conversationUlid: "conversation",
		status: "paused",
		objective: { markdown: "Ship it", revision: 1, updatedAt: 0 },
		createdAt: 0,
		updatedAt: 0,
		lastPausedAt: 0,
		activeDurationMs: 0,
		wakeSequence: 0,
		eventSequence: 0,
		events: [],
		children: [],
		accountingSources: {},
		accounting: {},
	}
}

describe("Goal accounting", () => {
	it("aggregates a field only when every attributable source reports it", () => {
		assert.deepEqual(
			calculateGoalAccounting({
				coordinator: { totalTokens: 10, inputTokens: 7, outputTokens: 3, cost: 0.1 },
				child: { totalTokens: 20, inputTokens: 12, outputTokens: 8 },
			}),
			{ totalTokens: 30, inputTokens: 19, outputTokens: 11 },
		)
	})

	it("preserves known zero values", () => {
		assert.deepEqual(calculateGoalAccounting({ coordinator: { totalTokens: 0, cost: 0 } }), {
			totalTokens: 0,
			cost: 0,
		})
	})

	it("replaces cumulative source snapshots without double counting", () => {
		const goal = record()
		replaceGoalAccountingSource(goal, "goal", { totalTokens: 10, cost: 0.1 })
		replaceGoalAccountingSource(goal, "goal", { totalTokens: 15, cost: 0.15 })
		replaceGoalAccountingSource(goal, "goal/child:1", { totalTokens: 5, cost: 0.05 })

		assert.deepEqual(goal.accounting, { totalTokens: 20, cost: 0.2 })
		assert.deepEqual(goal.accountingSources.goal, { totalTokens: 15, cost: 0.15 })
	})

	it("detaches persisted snapshots from caller mutation", () => {
		const goal = record()
		const snapshot = { totalTokens: 10 }
		replaceGoalAccountingSource(goal, "goal", snapshot)
		snapshot.totalTokens = 99

		assert.equal(goal.accountingSources.goal.totalTokens, 10)
		assert.equal(goal.accounting.totalTokens, 10)
	})

	it("rejects an empty source identity", () => {
		assert.throws(() => replaceGoalAccountingSource(record(), "", {}), /source identity cannot be empty/)
	})
})
