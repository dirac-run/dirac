import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { loadTaskletRecords, saveTaskletEvents, saveTaskletRecord, type TaskletRecord } from "@core/storage/taskStorage"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import type { TaskletHost } from "@core/task"
import { CardStatus } from "@shared/ExtensionMessage"
import { createTaskletId } from "@shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { HostProvider } from "@/hosts/host-provider"
import { loadGoalVerification } from "../GoalLoop"

const GOAL_ID = "1788000000001"

function record(overrides: Partial<TaskletRecord> = {}): TaskletRecord {
	return {
		id: createTaskletId(), rootTaskId: GOAL_ID, conversationUlid: "conversation",
		title: "Verification", prompt: "Verify the completed work", createdAt: 100,
		purpose: "goal_verification", ...overrides,
	}
}

function address(child: TaskletRecord) {
	return { kind: "tasklet" as const, rootTaskId: GOAL_ID, taskletId: child.id }
}

describe("Goal verification metadata", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "goal-presentation-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
	})

	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("uses only purpose-specific live observation, without listing children or reading transcripts", async () => {
		const child = record()
		const host = {
			latestObservationForPurpose: (purpose: string) => {
				assert.equal(purpose, "goal_verification")
				return { taskletId: child.id, title: child.title, createdAt: child.createdAt, state: "waiting_for_parent" }
			},
			list: () => assert.fail("Goal state must not construct a duplicate child inventory"),
		} as unknown as TaskletHost
		assert.deepEqual(await loadGoalVerification(GOAL_ID, host), {
			id: child.id, title: child.title, createdAt: child.createdAt, status: "waiting_for_parent",
		})
		await assert.rejects(fs.stat(getTaskDirectoryPath(GOAL_ID)), { code: "ENOENT" })
	})

	it("does not fall back to saved history when a live host has no verification", async () => {
		await saveTaskletRecord(record())
		const host = { latestObservationForPurpose: () => undefined } as unknown as TaskletHost
		assert.equal(await loadGoalVerification(GOAL_ID, host), undefined)
	})

	it("does not advertise an outcome record without its durable outcome event as settled", async () => {
		const child = record({ outcome: { kind: "completed", completedAt: 130, response: "Done" } })
		await saveTaskletRecord(child)
		assert.deepEqual(await loadGoalVerification(GOAL_ID), {
			id: child.id, title: child.title, createdAt: child.createdAt, status: "unsettled",
		})
	})

	it("reads saved acceptance without reviving or mutating historical pending requests", async () => {
		const child = record()
		await saveTaskletRecord(child)
		await saveTaskletEvents(address(child), [{
			id: "event-1", taskletId: child.id, createdAt: 120,
			communication: { type: "interaction", request: {
				id: "stale", status: "pending", createdAt: 120,
				card: { id: "card", header: "Approve", requireApproval: true, status: CardStatus.WAITING_FOR_INPUT, renderType: "text" },
			} },
		}])
		const directory = getTaskDirectoryPath(address(child))
		const before = await Promise.all((await fs.readdir(directory)).map(async (name) => [name, await fs.readFile(path.join(directory, name))]))
		assert.equal((await loadGoalVerification(GOAL_ID))?.status, "unsettled")
		assert.deepEqual(await loadTaskletRecords(GOAL_ID), [child])
		const after = await Promise.all((await fs.readdir(directory)).map(async (name) => [name, await fs.readFile(path.join(directory, name))]))
		assert.deepEqual(after, before)
	})

	it("preserves committed verification outcomes using the common tasklet status vocabulary", async () => {
		const outcomes: NonNullable<TaskletRecord["outcome"]>[] = [
			{ kind: "completed", completedAt: 130, response: "Verified" },
			{ kind: "failed", failedAt: 140, error: { name: "Error", message: "Failure" } },
			{ kind: "cancelled", cancelledAt: 150, reason: "User cancelled" },
			{ kind: "interrupted", interruptedAt: 160, reason: "Deadline" },
		]
		const summaries = []
		for (const [index, outcome] of outcomes.entries()) {
			const child = record({ createdAt: index, outcome })
			await saveTaskletRecord(child)
			await saveTaskletEvents(address(child), [{
				id: `outcome-${index}`, taskletId: child.id, createdAt: 200,
				communication: { type: "outcome", outcome },
			}])
			const summary = (await loadGoalVerification(GOAL_ID))!
			summaries.push({ status: summary.status, endedAt: summary.endedAt, terminalSummary: summary.terminalSummary })
		}
		assert.deepEqual(summaries, [
			{ status: "completed", endedAt: 130, terminalSummary: "Verified" },
			{ status: "failed", endedAt: 140, terminalSummary: "Error: Failure" },
			{ status: "interrupted", endedAt: 150, terminalSummary: "User cancelled" },
			{ status: "interrupted", endedAt: 160, terminalSummary: "Deadline" },
		])
	})

	it("chooses the latest verification deterministically and ignores ordinary tasklet titles", async () => {
		const first = record({ id: "tasklet_00000000-0000-4000-8000-000000000001" })
		const second = record({ id: "tasklet_00000000-0000-4000-8000-000000000002" })
		await saveTaskletRecord(second)
		await saveTaskletRecord(record({ purpose: undefined, title: "Verification is only a title", createdAt: 200 }))
		await saveTaskletRecord(first)
		assert.equal((await loadGoalVerification(GOAL_ID))?.id, second.id)
	})

	it("propagates malformed saved records instead of fabricating verification state", async () => {
		const child = record()
		await saveTaskletRecord(child)
		await fs.writeFile(path.join(getTaskDirectoryPath(address(child)), "tasklet.json"), "{broken")
		await assert.rejects(loadGoalVerification(GOAL_ID), SyntaxError)
	})
})
