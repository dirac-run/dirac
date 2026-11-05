import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { GoalRecord } from "@shared/goal"
import {
	applyGoalStatusTransition,
	goalActiveDurationAt,
	goalWallDurationAt,
} from "../GoalLifecycle"

function record(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		version: 2,
		id: "goal",
		conversationUlid: "conversation",
		status: "working",
		objective: { markdown: "Ship it", revision: 1, updatedAt: 100 },
		createdAt: 100,
		updatedAt: 100,
		lastActivatedAt: 100,
		activeDurationMs: 10,
		accountingSources: {},
		accounting: {},
		...overrides,
	}
}

describe("Goal lifecycle", () => {
	it("closes and reopens active-time segments across pause and resume", () => {
		const goal = record()
		assert.equal(applyGoalStatusTransition(goal, { status: "paused", statusReason: "User pause" }, 160), true)
		assert.equal(goal.activeDurationMs, 70)
		assert.equal(goal.lastActivatedAt, undefined)
		assert.equal(goal.lastPausedAt, 160)
		assert.equal(goal.statusReason, "User pause")

		assert.equal(applyGoalStatusTransition(goal, { status: "working" }, 200), true)
		assert.equal(goal.lastActivatedAt, 200)
		assert.equal(goalActiveDurationAt(goal, 230), 100)
	})

	it("keeps active timing continuous between working and waiting", () => {
		const goal = record()
		applyGoalStatusTransition(goal, { status: "waiting", statusReason: "Interaction" }, 140)

		assert.equal(goal.activeDurationMs, 10)
		assert.equal(goal.lastActivatedAt, 100)
		assert.equal(goalActiveDurationAt(goal, 170), 80)
	})

	it("makes repeated settled transitions idempotent", () => {
		const goal = record({ status: "paused", lastActivatedAt: undefined, lastPausedAt: 100 })
		assert.equal(applyGoalStatusTransition(goal, { status: "paused", statusReason: "Different" }, 120), false)
		assert.equal(goal.updatedAt, 100)
		assert.equal(goal.statusReason, undefined)
	})

	it("rejects illegal terminal and regressing-time transitions", () => {
		assert.throws(
			() => applyGoalStatusTransition(record({ status: "achieved", lastActivatedAt: undefined }), { status: "working" }, 100),
			/cannot transition from achieved to working/,
		)
		assert.throws(() => applyGoalStatusTransition(record(), { status: "paused" }, 99), /predates its last update/)
	})

	it("allows an explicitly stopped Goal to resume", () => {
		const goal = record({ status: "stopped", lastActivatedAt: undefined, updatedAt: 180 })

		assert.equal(applyGoalStatusTransition(goal, { status: "working", statusReason: "Resumed by user" }, 220), true)
		assert.equal(goal.status, "working")
		assert.equal(goal.lastActivatedAt, 220)
		assert.equal(goal.statusReason, "Resumed by user")
	})


	it("freezes wall duration at a terminal transition", () => {
		const goal = record()
		applyGoalStatusTransition(goal, { status: "achieved" }, 180)
		assert.equal(goalWallDurationAt(goal, 300), 80)
	})
})
