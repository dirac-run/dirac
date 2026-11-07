import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { GoalStore } from "../GoalStore"
import { goalWallDurationAt } from "../GoalLifecycle"

describe("GoalStore discovery", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "goal-store-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
	})

	afterEach(async () => {
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("leaves superseded Goal records out of current Goal discovery", async () => {
		const legacyDirectory = path.join(storagePath, "tasks", "legacy-goal")
		await fs.mkdir(legacyDirectory, { recursive: true })
		const legacyRecord = {
			schemaVersion: 5,
			revision: 1,
			definition: { contract: "Legacy objective" },
			status: "paused",
		}
		await fs.writeFile(path.join(legacyDirectory, "goal.json"), JSON.stringify(legacyRecord))

		assert.deepEqual(await new GoalStore().scanRecords(), {
			records: [],
			ownedDirectoryIds: ["legacy-goal"],
			failures: [],
		})
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(legacyDirectory, "goal.json"), "utf8")), legacyRecord)
	})

	it("reports an invalid current Goal record without failing the complete startup scan", async () => {
		const invalidDirectory = path.join(storagePath, "tasks", "current-goal")
		await fs.mkdir(invalidDirectory, { recursive: true })
		await fs.writeFile(path.join(invalidDirectory, "goal.json"), JSON.stringify({ version: 2 }))

		const report = await new GoalStore().scanRecords()
		assert.deepEqual(report.records, [])
		assert.equal(report.failures.length, 1)
		assert.equal(report.failures[0].goalId, "current-goal")
		assert.match(report.failures[0].error.message, /Invalid Goal state/)
	})

	it("stores lifecycle and accounting only, rejecting superseded registry fields", async () => {
		const store = new GoalStore(() => 100)
		const record = await store.create("goal", "conversation", "New objective")
		for (const field of ["children", "events", "wakeSequence", "lastWakeAt", "eventSequence"]) {
			assert.equal(Object.hasOwn(record, field), false)
			await assert.rejects(store.update("goal", (goal) => {
				Object.assign(goal, { [field]: field.endsWith("Sequence") ? 0 : [] })
			}), /unknown field/)
		}
		assert.deepEqual(await store.read("goal"), record)
	})

	for (const hasSettlementTime of [true, false]) {
		it(`preserves the settled endpoint through accounting updates (${hasSettlementTime ? "current" : "older"} record)`, async () => {
			let now = 100
			const store = new GoalStore(() => now)
			await store.create("goal", "conversation", "New objective")
			await store.transition("goal", { status: "working" })
			now = 180
			const settled = await store.transition("goal", { status: "achieved" })
			if (!hasSettlementTime) {
				delete settled.settledAt
				await fs.writeFile(path.join(storagePath, "tasks", "goal", "goal.json"), JSON.stringify(settled))
			}
			now = 300
			const updated = await store.update("goal", (goal) => {
				goal.accountingSources = { followup: { cost: 1 } }
				goal.accounting = { cost: 1 }
			})
			assert.equal(updated.updatedAt, 300)
			assert.equal(updated.settledAt, 180)
			assert.equal(goalWallDurationAt(updated, now), 80)
			assert.equal(updated.activeDurationMs, 80)
			assert.equal(updated.accounting.cost, 1)
			await assert.rejects(store.update("goal", (goal) => { goal.settledAt = 250 }), /lifecycle fields/)
		})
	}

	it("recovers only Goal lifecycle without changing contained tasklet artifacts", async () => {
		const store = new GoalStore(() => 100)
		await store.create("goal", "conversation", "New objective")
		await store.transition("goal", { status: "working" })
		const directory = path.join(storagePath, "tasks", "goal", "tasklets", "private-data")
		await fs.mkdir(directory, { recursive: true })
		const eventPath = path.join(directory, "tasklet_events.json")
		const original = Buffer.from("  [ { \"pending\": true } ]\n")
		await fs.writeFile(eventPath, original)

		const recovered = await new GoalStore(() => 200).recoverInterruptedExecution("goal")
		assert.equal(recovered.status, "paused")
		assert.equal(recovered.activeDurationMs, 100)
		assert.deepEqual(await fs.readFile(eventPath), original)
		assert.equal(Object.hasOwn(recovered, "children"), false)
	})
})
