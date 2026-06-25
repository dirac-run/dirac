import { expect } from "chai"
import { checkContextWindowExceededError } from "../context-error-handling"

describe("checkContextWindowExceededError", () => {
	it("detects OpenRouter context errors using structured status", () => {
		const error = Object.assign(
			new Error("This endpoint's maximum context length is 204800 tokens. However, you requested about 244027 tokens."),
			{
				status: 400,
			},
		)

		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("detects OpenRouter JSON-encoded status + context length errors", () => {
		const error = new Error(
			'OpenRouter Mid-Stream Error: {"status":400,"message":"This endpoint\'s maximum context length is 200000 tokens"}',
		)

		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("does not classify unrelated 400 errors as context window failures", () => {
		const error = new Error("OpenRouter API Error 400: Invalid API key")

		expect(checkContextWindowExceededError(error)).to.equal(false)
	})

	// Cerebras: status widened from number to String(status) === "400" — string status must also match.
	it("detects Cerebras context errors with string status '400'", () => {
		const error = Object.assign(new Error("Please reduce the length of the messages or completion"), {
			status: "400",
		})
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("detects Cerebras context errors with numeric status 400", () => {
		const error = Object.assign(new Error("Please reduce the length of the messages or completion"), {
			status: 400,
		})
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("rejects Cerebras errors with non-400 status even if message matches", () => {
		const error = Object.assign(new Error("Please reduce the length of the messages or completion"), {
			status: 500,
		})
		expect(checkContextWindowExceededError(error)).to.equal(false)
	})

	// Vercel: same String(status) === "400" widening — verify string status path.
	it("detects Vercel context errors with string status '400'", () => {
		const error = Object.assign(new Error("input is too long"), { status: "400" })
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("detects Vercel context errors with numeric status 400", () => {
		const error = Object.assign(new Error("input is too long"), { status: 400 })
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("rejects Vercel errors with non-400 status even if message matches context pattern", () => {
		const error = Object.assign(new Error("input is too long"), { status: 429 })
		expect(checkContextWindowExceededError(error)).to.equal(false)
	})

	// Vercel: explicit context_length_exceeded code short-circuits regardless of status.
	it("detects Vercel context_length_exceeded code without status", () => {
		const error = { error: { error: { code: "context_length_exceeded" } } }
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})
})
