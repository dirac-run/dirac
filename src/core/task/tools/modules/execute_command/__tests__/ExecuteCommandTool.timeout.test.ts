import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { isLikelyLongRunningCommand, resolveCommandTimeoutSeconds } from "../../../utils/CommandTimeoutUtils"

describe("ExecuteCommandTool timeout policy", () => {
	it("returns undefined when managed timeout is disabled", () => {
		const timeout = resolveCommandTimeoutSeconds("npm test", false)
		assert.equal(timeout, undefined)
	})

	it("falls back to default timeout for short commands", () => {
		const timeout = resolveCommandTimeoutSeconds("ls -la", true)
		assert.equal(timeout, 30)
	})

	it("uses extended timeout for known long-running commands", () => {
		const timeout = resolveCommandTimeoutSeconds("npm run build", true)
		assert.equal(timeout, 300)
	})

	it("detects common long-running command families", () => {
		assert.equal(isLikelyLongRunningCommand("cargo build --release"), true)
		assert.equal(isLikelyLongRunningCommand("docker build ."), true)
		assert.equal(isLikelyLongRunningCommand("pytest -q"), true)
	})
})
