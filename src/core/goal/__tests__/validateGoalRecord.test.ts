import assert from "node:assert/strict"
import { describe, it } from "mocha"
import type { GoalRecord } from "@shared/goal"
import { assertGoalRecord } from "../validateGoalRecord"

function record(): GoalRecord {
	return {
		version: 2,
		id: "goal",
		conversationUlid: "conversation",
		status: "paused",
		objective: { markdown: "Ship it", revision: 1, updatedAt: 100 },
		createdAt: 100,
		updatedAt: 100,
		lastPausedAt: 100,
		activeDurationMs: 0,
		accountingSources: {},
		accounting: {},
	}
}

describe("Goal lifecycle-only record validation", () => {
	it("accepts the new lifecycle/accounting format and known-zero accounting", () => {
		assert.doesNotThrow(() => assertGoalRecord(record(), "goal"))
		const goal = record()
		goal.accountingSources = { goal: { inputTokens: 0, cost: 0 } }
		goal.accounting = { inputTokens: 0, cost: 0 }
		assert.doesNotThrow(() => assertGoalRecord(goal, "goal"))
	})

	for (const field of ["children", "events", "eventSequence", "wakeSequence", "lastWakeAt"]) {
		it(`rejects retired ${field} state instead of treating it as an executable registry`, () => {
			assert.throws(() => assertGoalRecord({ ...record(), [field]: [] }, "goal"), /unknown field/)
		})
	}

	it("rejects legacy records actionably before validating or accepting their event state", () => {
		for (const legacy of [{ version: 1, children: [{}], events: [{}] }, { schemaVersion: 5 }]) {
			assert.throws(() => assertGoalRecord(legacy, "goal"), /legacy execution format.*Create a new Goal/)
		}
	})

	it("keeps identity, status and objective boundaries strict", () => {
		for (const invalid of [
			{ id: "other" },
			{ version: 3 },
			{ conversationUlid: "" },
			{ status: "running" },
			{ objective: { markdown: " ", revision: 1, updatedAt: 100 } },
			{ objective: { markdown: "Good", revision: 0, updatedAt: 100 } },
			{ objective: { markdown: "Good", revision: 1, updatedAt: 99 } },
			{ objective: { markdown: "Good", revision: 1, updatedAt: 100, extra: true } },
		]) assert.throws(() => assertGoalRecord({ ...record(), ...invalid }, "goal"), /Invalid Goal state/)
	})

	it("validates lifecycle timing without child or wake bookkeeping", () => {
		for (const invalid of [
			{ updatedAt: 99 },
			{ activeDurationMs: -1 },
			{ lastPausedAt: 101 },
			{ status: "working" },
			{ status: "waiting", lastActivatedAt: 99 },
			{ status: "paused", lastActivatedAt: 100 },
		]) assert.throws(() => assertGoalRecord({ ...record(), ...invalid }, "goal"), /Invalid Goal state/)
		assert.doesNotThrow(() => assertGoalRecord({ ...record(), status: "working", lastActivatedAt: 100 }, "goal"))
	})

	it("requires exact replaceable accounting projections and valid source snapshots", () => {
		for (const invalid of [
			{ accountingSources: { "": {} } },
			{ accountingSources: { goal: { cost: -1 } } },
			{ accountingSources: { goal: { inputTokens: 1.5 } } },
			{ accountingSources: { goal: { madeUpMetric: 1 } } },
			{ accountingSources: { goal: { inputTokens: 5 } }, accounting: { inputTokens: 6 } },
			{ accountingSources: { goal: {} }, accounting: { cost: 0 } },
		]) assert.throws(() => assertGoalRecord({ ...record(), ...invalid }, "goal"), /Invalid Goal state/)
	})
})
