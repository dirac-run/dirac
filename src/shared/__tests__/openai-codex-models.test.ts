import { describe, it } from "mocha"
import "should"
import { openAiCodexModels } from "../api"

describe("openAiCodexModels", () => {
	it("includes GPT-5.4, GPT-5.5, and GPT-5.6 variants available through ChatGPT Codex auth", () => {
		Object.keys(openAiCodexModels).should.deepEqual([
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.4-nano",
			"gpt-5.4-pro",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		])
	})

	it("defines GPT-5.5 metadata", () => {
		openAiCodexModels["gpt-5.5"].contextWindow!.should.equal(1_050_000)
		openAiCodexModels["gpt-5.5"].maxTokens!.should.equal(128_000)
		openAiCodexModels["gpt-5.5"].supportsReasoning!.should.equal(true)
		openAiCodexModels["gpt-5.5"].description!.should.containEql("Dec 01, 2025")
	})
})
