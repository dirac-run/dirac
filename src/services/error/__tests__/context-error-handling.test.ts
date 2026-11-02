import { expect } from "chai"
import { APIError } from "openai"
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

	it("detects the statusless Codex context-window stream error", () => {
		const error = new Error(
			"Codex API stream error: Your input exceeds the context window of this model. Please adjust your input and try again.",
		)

		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("detects a top-level Responses API context error code", () => {
		const error = Object.assign(new Error("Codex API stream error: Request failed"), {
			code: "context_length_exceeded",
		})

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

	// OpenAI SDK APIError path (code 400 + context-length message).
	it("detects an OpenAI APIError with code 400 and a context message", () => {
		const error = new APIError(
			400,
			{ code: "400", message: "This model's maximum context length is 204800 tokens." },
			undefined,
			undefined,
		)
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("does not classify a non-context OpenAI APIError", () => {
		const error = new APIError(400, { code: "400", message: "Invalid API key" }, undefined, undefined)
		expect(checkContextWindowExceededError(error)).to.equal(false)
	})

	// Anthropic: invalid_request_error type.
	it("detects an Anthropic invalid_request_error context error", () => {
		const error = { error: { error: { type: "invalid_request_error" } } }
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("rejects an Anthropic non-invalid_request_error", () => {
		const error = { error: { error: { type: "overloaded_error" } } }
		expect(checkContextWindowExceededError(error)).to.equal(false)
	})

	// Bedrock: ValidationException / stream_initialization_failed.
	it("detects a Bedrock ValidationException context error", () => {
		const error = Object.assign(new Error("maximum tokens exceeds model limit"), { name: "ValidationException" })
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})

	it("rejects a Bedrock ValidationException without a context message", () => {
		const error = Object.assign(new Error("malformed input"), { name: "ValidationException" })
		expect(checkContextWindowExceededError(error)).to.equal(false)
	})

	it("detects a Bedrock stream_initialization_failed with a context message", () => {
		const error = { code: "stream_initialization_failed", message: "maximum tokens exceeds model limit" }
		expect(checkContextWindowExceededError(error)).to.equal(true)
	})
})
