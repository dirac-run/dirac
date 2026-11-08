import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { SUBAGENT_NAMES } from "./subagentNames"
import { createTaskletId, isTaskletId } from "./taskletId"

describe("root-owned scientist identity", () => {
	it("exhausts each deduplicated suffix round before advancing", () => {
		const names = [...new Set(SUBAGENT_NAMES)]
		assert.ok(names.length < SUBAGENT_NAMES.length, "fixture includes duplicate Faraday")
		const used = new Set<string>()
		for (let round = 1; round <= 3; round++) {
			for (const name of names) {
				const id = createTaskletId(used)
				assert.equal(id, round === 1 ? name : `${name} ${round}`)
				assert.equal(isTaskletId(id), true)
				assert.equal(used.has(id), false)
				used.add(id)
			}
		}
		assert.equal(used.size, names.length * 3)
	})

	it("uses the owning root's reservations, not process-global state or presentation history", () => {
		const firstRoot = new Set<string>()
		const id = createTaskletId(firstRoot)
		firstRoot.add(id)
		assert.equal(createTaskletId(new Set()), id)
		assert.notEqual(createTaskletId(firstRoot), id)
	})

	it("fills unused earlier rounds even when later-round IDs are already recorded", () => {
		assert.equal(createTaskletId(new Set(["Feynman", "Feynman 2", "Planck 2"])), "Planck")
	})

	it("validates safe opaque segments without parsing the allocation scheme", () => {
		for (const id of ["Planck 2", "von Neumann", "Schrödinger", "Gödel", "future-id", "1710000000000",
			"tasklet_12345678-1234-4123-8123-123456789abc"]) {
			assert.equal(isTaskletId(id), true)
			assert.equal(isTaskletId(JSON.parse(JSON.stringify(id))), true)
		}
	})

	for (const id of ["", ".", "..", "../Planck", "Planck/child", "Planck\\child", "C:\\escape",
		"bad\0id", "bad\nid", " Planck", "Planck ", "Planck.", "CON", "nul.txt", "x".repeat(129)]) {
		it(`rejects unsafe path segment ${JSON.stringify(id)}`, () => assert.equal(isTaskletId(id), false))
	}
})
