/**
 * Tests for ANTHROPIC_BETAS constant.
 * Verifies the centralized beta flags match the values they replaced
 * across anthropic, bedrock, and vertex providers.
 */
import { describe, it } from "mocha"
import "should"
import { ANTHROPIC_BETAS } from "./anthropic"

describe("ANTHROPIC_BETAS", () => {
	it("exposes the 1M context window beta flag", () => {
		ANTHROPIC_BETAS.CONTEXT_1M.should.equal("context-1m-2025-08-07")
	})
	it("every value is a non-empty string with no surrounding whitespace", () => {
		Object.values(ANTHROPIC_BETAS).forEach((beta) => {
			beta.should.be.a.String()
			beta.length.should.be.greaterThan(0)
			beta.should.equal(beta.trim())
		})
	})
	it("follows the anthropic beta naming convention (kebab-date)", () => {
		Object.values(ANTHROPIC_BETAS).forEach((beta) => {
			// Format: feature-name-YYYY-MM-DD
			beta.should.match(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/)
		})
	})
})
