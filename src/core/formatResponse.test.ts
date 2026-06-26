/**
 * Tests for formatResponse — verifies the moved module exports the same API.
 * Focuses on edge cases: null/undefined inputs, empty strings, missing params.
 */
import { describe, it } from "mocha"
import "should"
import { formatResponse } from "./formatResponse"

describe("formatResponse", () => {
	describe("toolError", () => {
		it("wraps error message in error tags", () => {
			formatResponse.toolError("boom").should.containEql("<error>")
			formatResponse.toolError("boom").should.containEql("boom")
			formatResponse.toolError("boom").should.containEql("</error>")
		})
		it("handles undefined error", () => {
			formatResponse.toolError(undefined).should.containEql("<error>")
		})
		it("handles empty string error", () => {
			formatResponse.toolError("").should.containEql("<error>")
		})
	})

	describe("toolDenied", () => {
		it("returns denial message", () => {
			formatResponse.toolDenied().should.containEql("denied")
		})
	})

	describe("toolDeniedWithFeedback", () => {
		it("includes the feedback", () => {
			const result = formatResponse.toolDeniedWithFeedback("my feedback")
			result.should.containEql("my feedback")
			result.should.containEql("<feedback>")
		})
		it("handles empty feedback", () => {
			formatResponse.toolDeniedWithFeedback("").should.containEql("<feedback>")
		})
	})

	describe("missingToolParameterError", () => {
		it("includes parameter name and example", () => {
			const result = formatResponse.missingToolParameterError("path", "src/index.ts")
			result.should.containEql("path")
			result.should.containEql("src/index.ts")
		})
		it("handles missing example", () => {
			const result = formatResponse.missingToolParameterError("path")
			result.should.containEql("path")
		})
		it("handles empty parameter name", () => {
			formatResponse.missingToolParameterError("").should.be.a.String()
		})
	})

	describe("imageBlocks", () => {
		it("returns empty array for undefined", () => {
			formatResponse.imageBlocks(undefined).should.deepEqual([])
		})
		it("returns empty array for empty array", () => {
			formatResponse.imageBlocks([]).should.deepEqual([])
		})
		it("converts base64 strings to image blocks", () => {
			const blocks = formatResponse.imageBlocks(["data:image/png;base64,iVBORw0KGgo="])
			blocks.should.have.length(1)
			blocks[0].should.have.property("type", "image")
		})
	})

	describe("formatFilesList", () => {
		it("handles empty results", () => {
			const result = formatResponse.formatFilesList("/test", [], false)
			result.should.be.a.String()
		})
	})

	describe("createPrettyPatch", () => {
		it("generates a diff patch", () => {
			const patch = formatResponse.createPrettyPatch("test.ts", "old\n", "new\n")
			patch.should.containEql("-old")
		})
		it("handles undefined old content", () => {
			const patch = formatResponse.createPrettyPatch("test.ts", undefined, "new\n")
			patch.should.be.a.String()
		})
	})

	describe("noToolsUsed", () => {
		it("returns a string for native tool calls", () => {
			formatResponse.noToolsUsed(true).should.be.a.String()
		})
		it("returns a string for non-native tool calls", () => {
			formatResponse.noToolsUsed(false).should.be.a.String()
		})
	})

	describe("tooManyMistakes", () => {
		it("returns a string without feedback", () => {
			formatResponse.tooManyMistakes().should.be.a.String()
		})
		it("includes feedback when provided", () => {
			formatResponse.tooManyMistakes("my feedback").should.containEql("my feedback")
		})
	})
})
