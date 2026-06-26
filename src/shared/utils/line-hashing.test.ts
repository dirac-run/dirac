import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { stripHashes, stripHashesFromDiff } from "./line-hashing"

describe("line-hashing strip helpers", () => {
	describe("stripHashes", () => {
		it("strips only true line-start anchor prefixes", () => {
			assert.strictEqual(stripHashes("Anchor§line"), "line")
			assert.strictEqual(stripHashes('Anchor§const x = "Literal§inside"'), 'const x = "Literal§inside"')
		})

		it("preserves interior and indented anchor-like literals", () => {
			assert.strictEqual(stripHashes("line with Literal§text"), "line with Literal§text")
			assert.strictEqual(stripHashes("  Anchor§line"), "  Anchor§line")
			assert.strictEqual(stripHashes("+Anchor§line"), "+Anchor§line")
			assert.strictEqual(stripHashes("-Anchor§line"), "-Anchor§line")
			assert.strictEqual(stripHashes(" Anchor§line"), " Anchor§line")
		})
	})

	describe("stripHashesFromDiff", () => {
		it("preserves diff markers while stripping anchors after them", () => {
			assert.strictEqual(stripHashesFromDiff("+Anchor§line"), "+line")
			assert.strictEqual(stripHashesFromDiff("-Anchor§line"), "-line")
			assert.strictEqual(stripHashesFromDiff(" Anchor§line"), " line")
		})

		it("uses raw strip behavior for non-diff lines", () => {
			assert.strictEqual(stripHashesFromDiff("Anchor§line"), "line")
			assert.strictEqual(stripHashesFromDiff("  Anchor§line"), "  Anchor§line")
			assert.strictEqual(stripHashesFromDiff("+not an anchor Literal§line"), "+not an anchor Literal§line")
		})
	})
})
