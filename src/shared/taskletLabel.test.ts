import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { formatAgentLabel, formatTaskletLabel } from "./taskletLabel"

describe("Agent display labels", () => {
	it("decorates non-default roles with square brackets without changing the identity", () => {
		const identity = { id: "Feynman", role: "Saved custom role" }
		assert.equal(formatAgentLabel(identity), "Feynman [Saved custom role]")
		assert.deepEqual(identity, { id: "Feynman", role: "Saved custom role" })
	})

	it("suppresses missing, empty and case-insensitive default roles", () => {
		for (const role of [undefined, "", "default", "DEFAULT", "DeFaUlT"]) {
			assert.equal(formatAgentLabel({ id: "Feynman", role }), "Feynman")
		}
	})

	it("never decorates Dirac with a role", () => {
		assert.equal(formatAgentLabel({ id: "Dirac", role: "Coder" }), "Dirac")
		assert.equal(formatTaskletLabel({ taskletId: "Dirac", title: "Coordinate work", role: "Coder" }), "Dirac — Coordinate work")
	})

	it("separates the stable agent label from the assignment title", () => {
		assert.equal(formatTaskletLabel({ taskletId: "Feynman", title: "Review changes", role: "Reviewer" }), "Feynman [Reviewer] — Review changes")
		assert.equal(formatTaskletLabel({ taskletId: "Feynman", title: "Review changes", role: "default" }), "Feynman — Review changes")
	})

	it("formats legacy title-only labels without inventing an ID or role", () => {
		assert.equal(formatTaskletLabel({ title: "Review changes", role: "Reviewer" }), "Review changes [Reviewer]")
		assert.equal(formatTaskletLabel({ title: "Review changes", role: "default" }), "Review changes")
		assert.equal(formatTaskletLabel({ title: "Review changes" }), "Review changes")
	})
})
