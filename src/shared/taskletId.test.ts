import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { SUBAGENT_NAMES } from "./subagentNames"
import { createTaskletId, isTaskletId } from "./taskletId"

describe("root-owned scientist identity", () => {
	const names = [...new Set(SUBAGENT_NAMES)]

	afterEach(() => sinon.restore())

	it("has only whitespace-free, safe names in the pool", () => {
		for (const name of SUBAGENT_NAMES) {
			assert.doesNotMatch(name, /\s/)
			assert.equal(isTaskletId(name), true)
		}
		assert.ok(names.includes("vonNeumann"))
		assert.ok(names.includes("deBroglie"))
	})

	it("can select every available name through equal-sized random buckets", () => {
		const random = sinon.stub(Math, "random")
		const used = new Set<string>([names[0], names[2]])
		const available = names.filter((name) => !used.has(name))
		for (let index = 0; index < available.length; index++) {
			random.returns((index + 0.5) / available.length)
			assert.equal(createTaskletId(used), available[index])
		}
		random.returns(0)
		assert.equal(createTaskletId(used), available[0])
		random.returns(1 - Number.EPSILON)
		assert.equal(createTaskletId(used), available[available.length - 1])
		assert.deepEqual([...used], [names[0], names[2]], "the owning host reserves IDs, not the allocator")
	})

	it("exhausts each deduplicated suffix round before advancing without repeating IDs", () => {
		sinon.stub(Math, "random").returns(0.5)
		const used = new Set<string>()
		for (let round = 1; round <= 3; round++) {
			const remaining = new Set(names.map((name) => round === 1 ? name : `${name}${round}`))
			for (let index = 0; index < names.length; index++) {
				const id = createTaskletId(used)
				assert.equal(remaining.delete(id), true)
				assert.equal(isTaskletId(id), true)
				assert.doesNotMatch(id, /\s/)
				assert.equal(used.has(id), false)
				used.add(id)
			}
			assert.equal(remaining.size, 0)
		}
		assert.equal(used.size, names.length * 3)
	})

	it("uses the owning root's reservations, not process-global state or presentation history", () => {
		sinon.stub(Math, "random").returns(0.5)
		const firstRoot = new Set<string>()
		const id = createTaskletId(firstRoot)
		firstRoot.add(id)
		assert.equal(createTaskletId(new Set()), id)
		assert.notEqual(createTaskletId(firstRoot), id)
	})

	it("fills unused earlier rounds even when later-round IDs are already recorded", () => {
		const used = new Set<string>(names.filter((name) => name !== "Planck"))
		used.add("Feynman2")
		used.add("Planck2")
		assert.equal(createTaskletId(used), "Planck")
		used.add("Planck")
		for (const name of names) {
			if (name !== "Bohr") used.add(`${name}2`)
		}
		used.add("Bohr3")
		assert.equal(createTaskletId(used), "Bohr2")
	})

	it("validates current and legacy safe opaque segments without parsing the allocation scheme", () => {
		for (const id of ["Planck2", "vonNeumann", "deBroglie", "Planck 2", "von Neumann", "de Broglie",
			"Schrödinger", "Gödel", "future-id", "1710000000000", "tasklet_12345678-1234-4123-8123-123456789abc"]) {
			assert.equal(isTaskletId(id), true)
			assert.equal(isTaskletId(JSON.parse(JSON.stringify(id))), true)
		}
	})

	for (const id of ["", ".", "..", "../Planck", "Planck/child", "Planck\\child", "C:\\escape",
		"bad\0id", "bad\nid", " Planck", "Planck ", "Planck.", "CON", "nul.txt", "x".repeat(129)]) {
		it(`rejects unsafe path segment ${JSON.stringify(id)}`, () => assert.equal(isTaskletId(id), false))
	}
})
