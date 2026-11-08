import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { supportsCustomModelId } from "./customModelIds"

describe("custom model ID selection", () => {
	it("allows existing compatible endpoint and aggregator paths", () => {
		for (const provider of ["openai", "lmstudio", "litellm", "openrouter", "requesty", "together", "huggingface", "vercel-ai-gateway", "aihubmix"] as const) {
			assert.equal(supportsCustomModelId(provider), true, provider)
		}
	})

	it("does not expand direct provider or specialized Bedrock model selection", () => {
		for (const provider of ["anthropic", "deepseek", "gemini", "openai-native", "bedrock", "claude-code", "qwen-code"] as const) {
			assert.equal(supportsCustomModelId(provider), false, provider)
		}
	})
})
