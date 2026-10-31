import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { createTaskletId, isTaskletId } from "./taskletId"

const TASKLET_ID = "tasklet_12345678-1234-4123-8123-123456789abc"

describe("tasklet identity", () => {
	it("generates distinct path-independent tasklet IDs instead of canonical timestamp Task IDs", () => {
		const ids = Array.from({ length: 100 }, () => createTaskletId())
		assert.equal(new Set(ids).size, ids.length)
		for (const id of ids) {
			assert.equal(isTaskletId(id), true)
			assert.equal(/^\d+$/.test(id), false)
			assert.equal(/[\\/]/.test(id), false)
		}
	})

	it("classifies the same serialized handle without runtime or ownership state", () => {
		assert.equal(isTaskletId(TASKLET_ID), true)
		assert.equal(isTaskletId(JSON.parse(JSON.stringify(TASKLET_ID))), true)
	})

	for (const id of [
		"",
		"1710000000000",
		"legacy-task",
		"tasklet_",
		"tasklet_not-a-uuid",
		TASKLET_ID.replace("-4123-", "-1123-"),
		TASKLET_ID.replace("-8123-", "-7123-"),
		TASKLET_ID.toUpperCase(),
		` ${TASKLET_ID}`,
		`${TASKLET_ID}\n`,
		`${TASKLET_ID}\0`,
		`../${TASKLET_ID}`,
		`..\\${TASKLET_ID}`,
		`${TASKLET_ID}/..`,
	]) {
		it(`rejects non-tasklet or malformed identity ${JSON.stringify(id)}`, () => {
			assert.equal(isTaskletId(id), false)
		})
	}
})
