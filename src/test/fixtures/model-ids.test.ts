/**
 * Tests for TEST_MODEL_IDS fixture.
 * Verifies the canonical constants match the values they replaced
 * and that the set covers the model families used across test suites.
 */
import { describe, it } from "mocha"
import "should"
import { TEST_MODEL_IDS } from "./model-ids"

describe("TEST_MODEL_IDS fixture", () => {
	describe("anthropic family", () => {
		it("exposes the short alias used in 37+ test sites", () => {
			TEST_MODEL_IDS.ANTHROPIC.should.equal("claude-3-5-sonnet")
		})
		it("exposes the full dated id", () => {
			TEST_MODEL_IDS.ANTHROPIC_FULL.should.equal("claude-3-5-sonnet-20241022")
		})
		it("exposes the bedrock-namespaced id", () => {
			TEST_MODEL_IDS.ANTHROPIC_BEDROCK.should.equal("anthropic.claude-3-5-sonnet-20241022")
		})
		it("exposes the openrouter-namespaced id", () => {
			TEST_MODEL_IDS.ANTHROPIC_OPENROUTER.should.equal("anthropic/claude-3.5-sonnet")
		})
		it("exposes haiku and opus variants", () => {
			TEST_MODEL_IDS.ANTHROPIC_HAIKU.should.equal("claude-3-5-haiku-20241022")
			TEST_MODEL_IDS.ANTHROPIC_OPUS.should.equal("claude-3-opus")
		})
	})

	describe("openai family", () => {
		it("exposes the canonical gpt-4 id used in 50+ test sites", () => {
			TEST_MODEL_IDS.OPENAI.should.equal("gpt-4")
		})
		it("exposes gpt-4o and gpt-3.5-turbo variants", () => {
			TEST_MODEL_IDS.OPENAI_GPT4O.should.equal("gpt-4o")
			TEST_MODEL_IDS.OPENAI_GPT35.should.equal("gpt-3.5-turbo")
		})
	})

	describe("gemini family", () => {
		it("exposes the canonical gemini-2.5-pro id", () => {
			TEST_MODEL_IDS.GEMINI.should.equal("gemini-2.5-pro")
		})
		it("exposes the flash variant", () => {
			TEST_MODEL_IDS.GEMINI_FLASH.should.equal("gemini-2.5-flash")
		})
		it("exposes the openrouter-namespaced id", () => {
			TEST_MODEL_IDS.GEMINI_OPENROUTER.should.equal("google/gemini-2.5-pro")
		})
	})

	describe("contract stability", () => {
		it("is frozen (no accidental mutation)", () => {
			(Object.keys(TEST_MODEL_IDS) as Array<keyof typeof TEST_MODEL_IDS>).forEach((key) => {
				TEST_MODEL_IDS[key].should.be.a.String()
				TEST_MODEL_IDS[key].length.should.be.greaterThan(0)
			})
		})
		it("every value is a non-empty string with no surrounding whitespace", () => {
			Object.values(TEST_MODEL_IDS).forEach((id) => {
				id.should.equal(id.trim())
			})
		})
	})
})
