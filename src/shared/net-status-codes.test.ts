/**
 * Tests for HTTP status code classification helpers.
 * Verifies correct classification of rate limits, auth errors, client/server errors.
 * Edge cases focus on boundary values and unexpected inputs.
 */
import { describe, it } from "mocha"
import "should"
import { isAuthError, isClientError, isRateLimited, isServerError, jsonHeaders } from "./net"

describe("status code helpers", () => {
	describe("isRateLimited", () => {
		it("returns true for 429", () => {
			isRateLimited(429).should.be.true()
		})
		it("returns false for 200", () => {
			isRateLimited(200).should.be.false()
		})
		it("returns false for 428 (not 429)", () => {
			isRateLimited(428).should.be.false()
		})
		it("returns false for 430 (not 429)", () => {
			isRateLimited(430).should.be.false()
		})
		it("returns false for 500", () => {
			isRateLimited(500).should.be.false()
		})
		it("returns false for 0", () => {
			isRateLimited(0).should.be.false()
		})
	})

	describe("isAuthError", () => {
		it("returns true for 401", () => {
			isAuthError(401).should.be.true()
		})
		it("returns true for 403", () => {
			isAuthError(403).should.be.true()
		})
		it("returns false for 400", () => {
			isAuthError(400).should.be.false()
		})
		it("returns false for 404", () => {
			isAuthError(404).should.be.false()
		})
		it("returns false for 500", () => {
			isAuthError(500).should.be.false()
		})
	})

	describe("isClientError", () => {
		it("returns false for 399 (just below range)", () => {
			isClientError(399).should.be.false()
		})
		it("returns true for 400 (lower boundary)", () => {
			isClientError(400).should.be.true()
		})
		it("returns true for 404", () => {
			isClientError(404).should.be.true()
		})
		it("returns true for 429", () => {
			isClientError(429).should.be.true()
		})
		it("returns true for 499 (upper boundary)", () => {
			isClientError(499).should.be.true()
		})
		it("returns false for 500 (just above range)", () => {
			isClientError(500).should.be.false()
		})
		it("returns false for 200", () => {
			isClientError(200).should.be.false()
		})
		it("returns false for 0", () => {
			isClientError(0).should.be.false()
		})
	})

	describe("isServerError", () => {
		it("returns false for 499 (just below range)", () => {
			isServerError(499).should.be.false()
		})
		it("returns true for 500 (lower boundary)", () => {
			isServerError(500).should.be.true()
		})
		it("returns true for 503", () => {
			isServerError(503).should.be.true()
		})
		it("returns true for 599 (upper boundary)", () => {
			isServerError(599).should.be.true()
		})
		it("returns false for 600 (just above range)", () => {
			isServerError(600).should.be.false()
		})
		it("returns false for 200", () => {
			isServerError(200).should.be.false()
		})
		it("returns false for 0", () => {
			isServerError(0).should.be.false()
		})
	})

	describe("mutual exclusivity", () => {
		it("no status is both client and server error", () => {
			for (let s = 100; s <= 600; s++) {
				if (isClientError(s)) isServerError(s).should.equal(false)
				if (isServerError(s)) isClientError(s).should.equal(false)
			}
		})
	})

	describe("jsonHeaders", () => {
		it("returns Content-Type application/json", () => {
			const headers = jsonHeaders()
			headers.should.have.property("Content-Type", "application/json")
		})
		it("returns a new object each call (no shared mutation)", () => {
			const h1 = jsonHeaders()
			const h2 = jsonHeaders()
			h1.should.not.equal(h2)
			h1["Content-Type"] = "text/plain"
			h2["Content-Type"].should.equal("application/json")
		})
		it("spreads correctly with custom headers", () => {
			const headers = { ...jsonHeaders(), Authorization: "Bearer token" }
			headers.should.have.property("Content-Type", "application/json")
			headers.should.have.property("Authorization", "Bearer token")
		})
	})
})
