import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { UserApprovedCommand } from "@shared/UserApprovedCommand"
import { areCommandSegmentsApproved, isUserApprovedCommandSegment } from "../UserApprovedCommandMatcher"

function matches(entries: UserApprovedCommand[]) {
	return (segment: string) => isUserApprovedCommandSegment(segment, entries)
}

describe("UserApprovedCommandMatcher", () => {
	for (const match of ["exact", "prefix"] as const) {
		it(`preserves argument boundaries in ${match} patterns`, () => {
			const isApproved = matches([{ command: "rm 'file --recursive'", match }])
			assert.equal(areCommandSegmentsApproved("rm file --recursive", isApproved), false)
			assert.equal(areCommandSegmentsApproved('rm "file --recursive"', isApproved), true)
			assert.equal(areCommandSegmentsApproved("rm file\\ --recursive", isApproved), true)
		})
	}

	it("preserves empty arguments and whitespace within arguments", () => {
		const isApproved = matches([{ command: "echo '' 'two  spaces'", match: "exact" }])
		assert.equal(areCommandSegmentsApproved("echo 'two spaces'", isApproved), false)
		assert.equal(areCommandSegmentsApproved("echo '' 'two spaces'", isApproved), false)
		assert.equal(areCommandSegmentsApproved('echo "" "two  spaces"', isApproved), true)
	})

	it("does not reinterpret quoted operators as command boundaries", () => {
		const isApproved = matches([{ command: "echo 'hello; rm file'", match: "exact" }])
		assert.equal(areCommandSegmentsApproved('echo "hello; rm file"', isApproved), true)
		assert.equal(areCommandSegmentsApproved("echo hello; rm file", isApproved), false)
	})

	it("matches exact commands only in exact mode", () => {
		const isApproved = matches([{ command: "npm test", match: "exact" }])

		assert.equal(areCommandSegmentsApproved("npm test", isApproved), true)
		assert.equal(areCommandSegmentsApproved("npm test -- --watch", isApproved), false)
	})

	it("allows additional arguments in prefix mode", () => {
		const isApproved = matches([{ command: "npm test", match: "prefix" }])

		assert.equal(areCommandSegmentsApproved("npm test -- --watch", isApproved), true)
	})

	it("allows stderr-to-stdout descriptor duplication in prefix mode", () => {
		const isApproved = matches([{ command: "uv run pytest", match: "prefix" }])

		assert.equal(areCommandSegmentsApproved("uv run pytest -v 2>&1", isApproved), true)
	})

	it("normalizes stderr-to-stdout descriptor duplication in exact mode", () => {
		const withoutRedirect = matches([{ command: "uv run pytest -v", match: "exact" }])
		const withRedirect = matches([{ command: "uv run pytest -v 2>&1", match: "exact" }])

		assert.equal(areCommandSegmentsApproved("uv run pytest -v 2>&1", withoutRedirect), true)
		assert.equal(areCommandSegmentsApproved("uv run pytest -v 2>&1", withRedirect), true)
		assert.equal(areCommandSegmentsApproved("uv run pytest -v", withRedirect), true)
	})

	it("does not treat quoted descriptor text as a redirect", () => {
		const isApproved = matches([{ command: "echo value", match: "exact" }])

		assert.equal(areCommandSegmentsApproved("echo '2>&1' value", isApproved), false)
	})

	it("requires every chained segment to be approved", () => {
		const isApproved = matches([
			{ command: "npm test", match: "exact" },
			{ command: "npm run lint", match: "exact" },
		])

		assert.equal(areCommandSegmentsApproved("npm test && npm run lint", isApproved), true)
		assert.equal(areCommandSegmentsApproved("npm test && rm -rf project", isApproved), false)
		assert.equal(areCommandSegmentsApproved("npm test 2>&1 && rm -rf project", isApproved), false)
	})

	it("rejects redirects before matching command segments", () => {
		const isApproved = matches([{ command: "npm test", match: "prefix" }])

		assert.equal(areCommandSegmentsApproved("npm test > output.txt", isApproved), false)
		assert.equal(areCommandSegmentsApproved("npm test < input.txt", isApproved), false)
		assert.equal(areCommandSegmentsApproved("npm test 2> errors.txt", isApproved), false)
	})

	it("rejects line-separated and background commands", () => {
		const isApproved = matches([{ command: "npm test", match: "prefix" }])

		assert.equal(areCommandSegmentsApproved("npm test\nrm -rf project", isApproved), false)
		assert.equal(areCommandSegmentsApproved("npm test\rrm -rf project", isApproved), false)
		assert.equal(areCommandSegmentsApproved("npm test & rm -rf project", isApproved), false)
	})

	it("rejects malformed command syntax", () => {
		const isApproved = matches([{ command: "npm test", match: "prefix" }])

		assert.equal(areCommandSegmentsApproved("npm test 'unterminated", isApproved), false)
	})
})
