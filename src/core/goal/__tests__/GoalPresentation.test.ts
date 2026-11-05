import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { loadTaskletRecords, saveTaskletEvents, saveTaskletRecord, type TaskletRecord } from "@core/storage/taskStorage"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import type { TaskletInspection, TaskletInteraction } from "@core/task/tools/interfaces/IToolEnvironment"
import { CardStatus, TaskStatus } from "@shared/ExtensionMessage"
import { createTaskletId } from "@shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { HostProvider } from "@/hosts/host-provider"
import { latestGoalVerification, loadGoalTaskSummaries as goalTaskSummaries } from "../GoalLoop"

const GOAL_ID = "1788000000001"

function record(overrides: Partial<TaskletRecord> = {}): TaskletRecord {
	return {
		id: createTaskletId(),
		rootTaskId: GOAL_ID,
		conversationUlid: "conversation",
		title: "Contained work",
		prompt: "Do the assigned work",
		createdAt: 100,
		...overrides,
	}
}

function interaction(id: string, status: TaskletInteraction["status"] = "pending"): TaskletInteraction {
	return {
		id,
		status,
		createdAt: 120,
		card: { id: `card-${id}`, header: "Approve", requireApproval: true, status: CardStatus.WAITING_FOR_INPUT, renderType: "text" },
	}
}

function inspection(value: TaskletRecord, interactions: TaskletInteraction[] = []): TaskletInspection {
	return { ...value, responses: [], interactions, backgroundCommandRunning: false, outcomePersisted: value.outcome !== undefined }
}

describe("Goal shared tasklet presentation", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "goal-presentation-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
	})

	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("uses live execution and pending requests without consulting or writing disk", async () => {
		const child = inspection(record(), [interaction("first"), interaction("second"), interaction("done", "resolved"), interaction("old", "retired")])
		child.executionStatus = TaskStatus.EXECUTING_TOOL
		const [summary] = await goalTaskSummaries(GOAL_ID, [child])

		assert.equal(summary.status, "waiting")
		assert.equal(summary.pendingInteractionCount, 2)
		assert.deepEqual(summary.pendingInteraction, { id: "first", kind: "approval", createdAt: 120 })
		assert.equal(summary.runningDurationMs, undefined)
		assert.equal(summary.idleDurationMs, undefined)
		await assert.rejects(fs.stat(getTaskDirectoryPath(GOAL_ID)), { code: "ENOENT" })
	})

	it("does not mistake a live engine completion flag for a durable child outcome", async () => {
		const child = inspection(record())
		child.executionStatus = TaskStatus.COMPLETED
		assert.equal((await goalTaskSummaries(GOAL_ID, [child]))[0].status, "accepted")
		child.executionStatus = TaskStatus.PREPARING
		assert.equal((await goalTaskSummaries(GOAL_ID, [child]))[0].status, "starting")
		child.executionStatus = TaskStatus.THINKING
		assert.equal((await goalTaskSummaries(GOAL_ID, [child]))[0].status, "running")
	})

	it("does not advertise an unpersisted live outcome as settled", async () => {
		const child = inspection(record({ outcome: { kind: "completed", completedAt: 130, response: "Done" } }))
		child.outcomePersisted = false
		child.executionStatus = TaskStatus.COMPLETED
		const [summary] = await goalTaskSummaries(GOAL_ID, [child])
		assert.equal(summary.status, "accepted")
		assert.equal(summary.endedAt, undefined)
		assert.equal(summary.terminalSummary, undefined)
	})

	it("reads persisted acceptance and historical requests without recovering or mutating them", async () => {
		const child = record()
		await saveTaskletRecord(child)
		await saveTaskletEvents({ kind: "tasklet", rootTaskId: GOAL_ID, taskletId: child.id }, [
			{ id: "event-1", taskletId: child.id, createdAt: 120, communication: { type: "interaction", request: interaction("stale") } },
		])
		const directory = getTaskDirectoryPath({ kind: "tasklet", rootTaskId: GOAL_ID, taskletId: child.id })
		const before = await Promise.all((await fs.readdir(directory)).map(async (name) => [name, await fs.readFile(path.join(directory, name))]))

		const [summary] = await goalTaskSummaries(GOAL_ID)
		assert.equal(summary.status, "accepted")
		assert.equal(summary.endedAt, undefined)
		assert.equal(summary.pendingInteractionCount, 1)
		assert.deepEqual(await loadTaskletRecords(GOAL_ID), [child])
		const after = await Promise.all((await fs.readdir(directory)).map(async (name) => [name, await fs.readFile(path.join(directory, name))]))
		assert.deepEqual(after, before)
	})

	it("projects all committed outcomes and hides stale pending requests on settled children", async () => {
		const outcomes: NonNullable<TaskletRecord["outcome"]>[] = [
			{ kind: "completed", completedAt: 130, response: "Verified" },
			{ kind: "failed", failedAt: 140, error: { name: "Error", message: "Failure" } },
			{ kind: "cancelled", cancelledAt: 150, reason: "User cancelled" },
			{ kind: "interrupted", interruptedAt: 160, reason: "Deadline" },
		]
		const summaries = await goalTaskSummaries(GOAL_ID, outcomes.map((outcome, index) => inspection(record({ createdAt: index, outcome }), [interaction("stale")])))

		assert.deepEqual(summaries.map(({ status, endedAt, terminalSummary }) => ({ status, endedAt, terminalSummary })), [
			{ status: "completed", endedAt: 130, terminalSummary: "Verified" },
			{ status: "failed", endedAt: 140, terminalSummary: "Error: Failure" },
			{ status: "cancelled", endedAt: 150, terminalSummary: "User cancelled" },
			{ status: "interrupted", endedAt: 160, terminalSummary: "Deadline" },
		])
		assert.ok(summaries.every((summary) => summary.pendingInteractionCount === 0 && !summary.pendingInteraction))
	})

	it("derives verification purpose and orders tied disk records deterministically", async () => {
		const firstId = "tasklet_00000000-0000-4000-8000-000000000001"
		const secondId = "tasklet_00000000-0000-4000-8000-000000000002"
		const first = record({ id: firstId, purpose: "goal_verification", title: "First verification" })
		const second = record({ id: secondId, purpose: "goal_verification", title: "Second verification" })
		const ordinary = record({ title: "Verification in a title is not a role", createdAt: 200 })
		await saveTaskletRecord(second)
		await saveTaskletRecord(ordinary)
		await saveTaskletRecord(first)

		const summaries = await goalTaskSummaries(GOAL_ID)
		assert.deepEqual(summaries.map(({ id }) => id), [first.id, second.id, ordinary.id])
		assert.deepEqual(summaries.map(({ role }) => role), ["verification", "verification", "task"])
		assert.equal(latestGoalVerification([...summaries].reverse())?.id, second.id)
		assert.equal(latestGoalVerification([summaries[2]]), undefined)
	})

	it("propagates malformed disk records instead of inventing empty child state", async () => {
		const child = record()
		await saveTaskletRecord(child)
		const directory = getTaskDirectoryPath({ kind: "tasklet", rootTaskId: GOAL_ID, taskletId: child.id })
		await fs.writeFile(path.join(directory, "tasklet.json"), "{broken")
		await assert.rejects(goalTaskSummaries(GOAL_ID), SyntaxError)
	})
})
