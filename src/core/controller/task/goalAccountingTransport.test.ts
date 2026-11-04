import { strict as assert } from "node:assert"
import { createGoalHistoryItem } from "@core/goal/GoalHistory"
import type { GoalAccounting, GoalRecord } from "@shared/goal"
import { historyItemFromProto } from "@shared/historyItemFromProto"
import { TaskItem, TaskResponse } from "@shared/proto/dirac/task"
import { describe, it } from "mocha"
import { historyItemToTaskItem } from "./getTaskHistory"
import { goalHistoryItemToTaskResponse } from "./showTaskWithId"

function goalRecord(accounting: GoalAccounting): GoalRecord {
	return {
		version: 2,
		id: "goal",
		conversationUlid: "conversation",
		status: "paused",
		statusReason: "Created",
		objective: { markdown: "Ship the Goal", revision: 1, updatedAt: 10 },
		createdAt: 10,
		updatedAt: 10,
		lastPausedAt: 10,
		activeDurationMs: 0,
		wakeSequence: 0,
		eventSequence: 0,
		events: [],
		children: [],
		accountingSources: {},
		accounting,
	}
}

const cases: Array<{ name: string; accounting: GoalAccounting }> = [
	{ name: "unavailable", accounting: {} },
	{
		name: "known zero",
		accounting: {
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
		},
	},
	{
		name: "positive",
		accounting: {
			totalTokens: 21,
			inputTokens: 12,
			outputTokens: 9,
			reasoningTokens: 3,
			cacheReadTokens: 4,
			cacheWriteTokens: 5,
			cost: 0.25,
		},
	},
]

function assertLegacyAccountingAbsent(value: object): void {
	const fields = value as Record<string, unknown>
	assert.equal(fields.totalCost, undefined)
	assert.equal(fields.tokensIn, undefined)
	assert.equal(fields.tokensOut, undefined)
	assert.equal(fields.cacheWrites, undefined)
	assert.equal(fields.cacheReads, undefined)
}

describe("Goal accounting transports", () => {
	for (const testCase of cases) {
		it(`round trips ${testCase.name} accounting without legacy fabrication`, () => {
			const historyItem = createGoalHistoryItem(goalRecord(testCase.accounting), "/goal Ship the Goal")
			assertLegacyAccountingAbsent(historyItem)

			const historyProto = TaskItem.decode(TaskItem.encode(historyItemToTaskItem(historyItem)).finish())
			assert.equal(historyProto.runKind, "goal")
			assertLegacyAccountingAbsent(historyProto)
			assert.deepEqual(historyProto.accounting, testCase.accounting)
			const restoredHistory = historyItemFromProto(historyProto)
			assert.equal(restoredHistory.runKind, "goal")
			assert.deepEqual(restoredHistory.accounting, testCase.accounting)

			const detailProto = TaskResponse.decode(TaskResponse.encode(goalHistoryItemToTaskResponse(historyItem)).finish())
			assert.equal(detailProto.runKind, "goal")
			assertLegacyAccountingAbsent(detailProto)
			assert.deepEqual(detailProto.accounting, testCase.accounting)
		})
	}
})
