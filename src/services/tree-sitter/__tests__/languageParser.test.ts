import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { isLanguageSupported } from "../languageParser"

describe("languageParser", () => {
	describe("isLanguageSupported", () => {
		it("returns true for supported code extensions", () => {
			assert.strictEqual(isLanguageSupported("ts"), true)
			assert.strictEqual(isLanguageSupported("js"), true)
			assert.strictEqual(isLanguageSupported("py"), true)
			assert.strictEqual(isLanguageSupported("cpp"), true)
		})

		it("returns false for unsupported or non-code extensions", () => {
			assert.strictEqual(isLanguageSupported("md"), false)
			assert.strictEqual(isLanguageSupported("txt"), false)
			assert.strictEqual(isLanguageSupported("json"), false)
			assert.strictEqual(isLanguageSupported(""), false)
		})
	})
})
