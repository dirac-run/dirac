import { strict as assert } from "node:assert"
import path from "path"
import { describe, it } from "mocha"
import { arePathsEqual, isLocatedInPath } from "@utils/path"

describe("isLocatedInPath", () => {
	const root = path.resolve(path.sep, "a", "proj")

	it("accepts the directory itself and its descendants", () => {
		assert.equal(isLocatedInPath(root, root), true)
		assert.equal(isLocatedInPath(root, path.join(root, "src", "index.ts")), true)
	})

	// Regression: a raw `startsWith(cwd)` test accepted any path whose string merely began with
	// cwd, so a sibling directory sharing the prefix slipped through the containment check.
	it("rejects a sibling directory that shares the prefix", () => {
		assert.equal(isLocatedInPath(root, `${root}-evil`), false)
		assert.equal(isLocatedInPath(root, `${root}-evil${path.sep}secret`), false)
	})

	it("rejects a parent and an unrelated path", () => {
		assert.equal(isLocatedInPath(root, path.dirname(root)), false)
		assert.equal(isLocatedInPath(root, path.resolve(path.sep, "b", "other")), false)
	})
})

describe("arePathsEqual", () => {
	it("ignores a trailing separator", () => {
		const p = path.resolve(path.sep, "a", "proj")
		assert.equal(arePathsEqual(p, p + path.sep), true)
	})

	it("distinguishes different paths", () => {
		assert.equal(arePathsEqual(path.resolve(path.sep, "a"), path.resolve(path.sep, "b")), false)
	})
})
