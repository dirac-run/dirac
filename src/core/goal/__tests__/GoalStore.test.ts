import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { GoalStore } from "../GoalStore"

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
})
