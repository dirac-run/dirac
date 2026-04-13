import { describe, it } from "mocha"
import "should"
import {
    GEMINI_MAX_OUTPUT_TOKENS,
    isClaude4Plus,
    isGeminiFlash,
    isGPT5,
    isGptOss,
    shouldSkipReasoningForModel,
} from "../model-utils"

describe("shouldSkipReasoningForModel", () => {
	it("should return true for grok-4 models", () => {
		shouldSkipReasoningForModel("grok-4").should.equal(true)
		shouldSkipReasoningForModel("x-ai/grok-4").should.equal(true)
		shouldSkipReasoningForModel("openrouter/grok-4-turbo").should.equal(true)
		shouldSkipReasoningForModel("some-provider/grok-4-mini").should.equal(true)
	})

	it("should return false for non-grok-4 models", () => {
		shouldSkipReasoningForModel("grok-3").should.equal(false)
		shouldSkipReasoningForModel("grok-2").should.equal(false)
		shouldSkipReasoningForModel("claude-3-sonnet").should.equal(false)
		shouldSkipReasoningForModel("gpt-4").should.equal(false)
		shouldSkipReasoningForModel("gemini-pro").should.equal(false)
	})

	it("should return false for undefined or empty model IDs", () => {
		shouldSkipReasoningForModel(undefined).should.equal(false)
		shouldSkipReasoningForModel("").should.equal(false)
	})

	it("should be case sensitive", () => {
		shouldSkipReasoningForModel("GROK-4").should.equal(false)
		shouldSkipReasoningForModel("Grok-4").should.equal(false)
	})
})

describe("isClaude4Plus", () => {
	it("should return true for Claude 4+ model IDs with version numbers", () => {
		isClaude4Plus("claude-sonnet-4-5-20250929").should.equal(true)
		isClaude4Plus("claude-opus-4-1-20250805").should.equal(true)
		isClaude4Plus("claude-haiku-4-5-20251001").should.equal(true)
		isClaude4Plus("claude-4-sonnet").should.equal(true)
	})

	it("should return true for Claude short aliases used by Claude Code", () => {
		// These are used by ClaudeCodeHandler.getModel() and should be recognized as Claude 4+
		isClaude4Plus("sonnet").should.equal(true)
		isClaude4Plus("opus").should.equal(true)
	})

	it("should return false for Claude 3.x models", () => {
		isClaude4Plus("claude-3-sonnet").should.equal(false)
		isClaude4Plus("claude-3.5-sonnet").should.equal(false)
		isClaude4Plus("claude-3-opus").should.equal(false)
	})

	it("should return false for non-Claude models", () => {
		isClaude4Plus("gpt-4").should.equal(false)
		isClaude4Plus("gemini-pro").should.equal(false)
		isClaude4Plus("llama-3").should.equal(false)
	})
})

describe("isGPT5", () => {
	it("should return true for GPT-5 model IDs with hyphen", () => {
		isGPT5("gpt-5").should.equal(true)
		isGPT5("gpt-5.1").should.equal(true)
		isGPT5("gpt-5.2-codex").should.equal(true)
		isGPT5("openai/gpt-5").should.equal(true)
	})

	it("should return true for GPT-5 model IDs without hyphen (OCA format)", () => {
		isGPT5("gpt5").should.equal(true)
		isGPT5("oca/gpt5").should.equal(true)
	})

	it("should be case insensitive", () => {
		isGPT5("GPT-5").should.equal(true)
		isGPT5("GPT5").should.equal(true)
		isGPT5("OCA/GPT5").should.equal(true)
	})

	it("should return false for non-GPT-5 models", () => {
		isGPT5("gpt-4").should.equal(false)
		isGPT5("gpt-4o").should.equal(false)
		isGPT5("gpt-oss-120b").should.equal(false)
		isGPT5("claude-3-sonnet").should.equal(false)
		isGPT5("gemini-pro").should.equal(false)
	})
})

describe("isGptOss", () => {
	it("should return true for gpt-oss model IDs", () => {
		isGptOss("gpt-oss-120b").should.equal(true)
		isGptOss("openai/gpt-oss-120b").should.equal(true)
		isGptOss("gpt_oss_120b").should.equal(true)
	})

	it("should be case insensitive", () => {
		isGptOss("GPT-OSS-120B").should.equal(true)
		isGptOss("OPENAI/GPT_OSS_120B").should.equal(true)
	})

	it("should return false for non-gpt-oss models", () => {
		isGptOss("gpt-5").should.equal(false)
		isGptOss("gpt-4o").should.equal(false)
		isGptOss("claude-sonnet-4").should.equal(false)
	})
})

describe("isGeminiFlash", () => {
	it("should return true for Gemini Flash model IDs", () => {
		isGeminiFlash("google/gemini-2.5-flash").should.equal(true)
		isGeminiFlash("google/gemini-3-flash-preview").should.equal(true)
		isGeminiFlash("google/gemini-2.5-flash-lite").should.equal(true)
	})

	it("should return false for non-Flash Gemini model IDs", () => {
		isGeminiFlash("google/gemini-2.5-pro").should.equal(false)
		isGeminiFlash("google/gemini-3-pro-preview").should.equal(false)
	})

	it("should return true for direct Gemini provider IDs", () => {
		isGeminiFlash("gemini-2.5-flash").should.equal(true)
		isGeminiFlash("gemini-3-flash-preview").should.equal(true)
	})

	it("should return false for non-matching IDs", () => {
		isGeminiFlash("openrouter/google/gemini-2.5-flash").should.equal(false)
		isGeminiFlash("google/gemini-2.5-pro").should.equal(false)
	})

	it("should be case insensitive", () => {
		isGeminiFlash("GOOGLE/GEMINI-2.5-FLASH").should.equal(true)
	})
})

describe("GEMINI_MAX_OUTPUT_TOKENS", () => {
	it("should be set to 8192", () => {
		GEMINI_MAX_OUTPUT_TOKENS.should.equal(8_192)
	})
})
