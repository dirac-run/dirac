import "should"
import { shouldRetryWithFullContext } from "../openai-responses-utils"

// Characterization tests for shouldRetryWithFullContext.
// The function decides whether a failed request should be retried with the full
// conversation context (no previous_response_id) — only when there was a previous
// response id AND the error indicates that id is no longer known to the server.
describe("shouldRetryWithFullContext", () => {
	it("returns false when there was no previous response id", () => {
		shouldRetryWithFullContext({ status: 404, message: "not found" }, false).should.equal(false)
	})

	it("returns true for previous_response_not_found error code", () => {
		shouldRetryWithFullContext({ code: "previous_response_not_found", message: "x" }, true).should.equal(true)
	})

	it("returns true when message contains previous_response_not_found", () => {
		shouldRetryWithFullContext(new Error("previous_response_not_found in stream"), true).should.equal(true)
	})

	it("returns true for HTTP 404 status", () => {
		shouldRetryWithFullContext({ status: 404, message: "missing" }, true).should.equal(true)
	})

	it("returns true when message contains 404 string", () => {
		shouldRetryWithFullContext(new Error("got 404 from server"), true).should.equal(true)
	})

	it("returns false for 404 with details.param === 'input' (item-level 404)", () => {
		shouldRetryWithFullContext({ status: 404, message: "missing", details: { param: "input" } }, true).should.equal(false)
	})

	it("returns true for websocket_closed error code", () => {
		shouldRetryWithFullContext({ code: "websocket_closed", message: "x" }, true).should.equal(true)
	})

	it("returns true for websocket_error error code", () => {
		shouldRetryWithFullContext({ code: "websocket_error", message: "x" }, true).should.equal(true)
	})

	it("returns false for unrelated errors", () => {
		shouldRetryWithFullContext({ status: 500, message: "server error" }, true).should.equal(false)
	})
})
