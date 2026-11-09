import { expect } from "chai"
import { describe, it } from "mocha"
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "@/utils/cost"
import { anthropicDefaultModelId, anthropicModels, getAnthropicReasoningEffort, getAnthropicThinkingConfig } from "../anthropic"
import { bedrockDefaultModelId, bedrockModels } from "../bedrock"
import { claudeCodeDefaultModelId, claudeCodeModels } from "../claude-code"
import { vertexDefaultModelId, vertexGlobalModels, vertexModels } from "../vertex"
import type { ModelInfo } from "../types"

const currentIds = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] as const

describe("current Claude model catalog", () => {
	for (const id of currentIds) {
		it(`offers ${id} with documented limits on each supported provider`, () => {
			const supported: ModelInfo[] = [anthropicModels[id], vertexModels[id], claudeCodeModels[id]]
			if (id !== "claude-fable-5-1") supported.push(bedrockModels[`anthropic.${id}`])
			for (const info of supported) {
				expect(info.contextWindow).to.equal(1_000_000)
				expect(info.maxTokens).to.equal(128_000)
				expect(info.supportsAdaptiveThinking).to.equal(true)
				expect(info.reasoningEffortOptions).to.deep.equal(["low", "medium", "high", "xhigh", "max"])
				expect(info).not.to.have.property("supportsFastMode", true)
			}
			expect(vertexGlobalModels).to.have.property(id)
			expect(claudeCodeModels[id].supportsImages).to.equal(false)
			expect(claudeCodeModels[id].supportsPromptCache).to.equal(false)
		})
	}

	it("keeps existing defaults and IDs", () => {
		expect(anthropicDefaultModelId).to.equal("claude-sonnet-5")
		expect(bedrockDefaultModelId).to.equal("anthropic.claude-sonnet-5")
		expect(claudeCodeDefaultModelId).to.equal("claude-sonnet-5")
		expect(vertexDefaultModelId).to.equal("gemini-3-pro-preview")
		expect(anthropicModels).to.have.property("claude-haiku-4-5-20251001")
		expect(bedrockModels).to.have.property("anthropic.claude-fable-5-v1")
		expect(vertexModels).to.have.property("claude-haiku-4-5@20251001")
	})

	it("records current standard and cache prices without changing older rates", () => {
		for (const catalog of [anthropicModels, vertexModels]) {
			expect(catalog["claude-sonnet-5-5"]).to.include({ inputPrice: 2, outputPrice: 10, cacheWritesPrice: 2.5, cacheReadsPrice: 0.1 })
			expect(catalog["claude-fable-5-1"]).to.include({ inputPrice: 10, outputPrice: 50, cacheWritesPrice: 12.5, cacheReadsPrice: 0.25 })
			expect(catalog["claude-fable-5"].cacheReadsPrice).to.equal(1)
		}
	})
	it("leaves unverified Bedrock prices unknown and omits the consent-gated Fable model", () => {
		for (const id of ["anthropic.claude-sonnet-5-5", "anthropic.claude-haiku-5-5"] as const) {
			expect(bedrockModels[id]).not.to.have.property("inputPrice")
			expect(bedrockModels[id]).not.to.have.property("outputPrice")
			expect(bedrockModels[id]).not.to.have.property("tiers")
		}
		expect(bedrockModels).not.to.have.property("anthropic.claude-fable-5-1")
	})

	it("uses Claude Code's own thinking and effort defaults", () => {
		expect(claudeCodeModels["claude-sonnet-5-5"].defaultReasoningEffort).to.equal("medium")
		expect(claudeCodeModels["claude-sonnet-5-5"].supportsBetweenToolsThinking).to.equal(false)
		expect(claudeCodeModels["claude-sonnet-5-5"].thinkingAlwaysOn).to.equal(true)
		expect(claudeCodeModels["claude-haiku-5-5"].thinkingAlwaysOn).to.equal(true)
	})

	it("prices Haiku at the inclusive 100K boundary, counting cache reads and writes", () => {
		for (const info of [anthropicModels["claude-haiku-5-5"], vertexModels["claude-haiku-5-5"]]) {
			// 10K uncached + 20K writes + 70K reads: exactly 100K, all at the lower rates.
			expect(calculateApiCostAnthropic(info, 10_000, 1_000, 20_000, 70_000)).to.be.closeTo(0.0047, 1e-12)
			// One extra cached token raises every price, including output and uncached input.
			expect(calculateApiCostAnthropic(info, 10_000, 1_000, 20_000, 70_001)).to.be.closeTo(0.02350005, 1e-12)
			expect(calculateApiCostOpenAI(info, 100_001, 1_000, 20_000, 70_001)).to.be.closeTo(0.02350005, 1e-12)
		}
	})
})

describe("Claude thinking compatibility", () => {
	for (const id of currentIds) {
		it(`defaults ${id} to adaptive without a saved budget`, () => {
			expect(getAnthropicThinkingConfig(id, anthropicModels[id], undefined)).to.deep.equal({ type: "adaptive", display: "summarized" })
		})
		for (const effort of ["xhigh", "max"]) {
			it(`uses adaptive for ${id} at ${effort} even with a saved zero budget`, () => {
				expect(getAnthropicThinkingConfig(id, anthropicModels[id], 0, effort)).to.deep.equal({ type: "adaptive", display: "summarized" })
			})
		}
	}

	it("uses between_tools without display or budget for Sonnet's explicit off setting", () => {
		expect(getAnthropicThinkingConfig("claude-sonnet-5-5", anthropicModels["claude-sonnet-5-5"], 0)).to.deep.equal({ type: "between_tools" })
	})

	it("explicitly disables Haiku thinking at high or lower", () => {
		for (const effort of ["low", "medium", "high"]) {
			expect(getAnthropicThinkingConfig("claude-haiku-5-5", anthropicModels["claude-haiku-5-5"], 0, effort)).to.deep.equal({ type: "disabled" })
		}
	})

	it("keeps Fable thinking on and normalizes unsupported saved effort to high", () => {
		const info = anthropicModels["claude-fable-5-1"]
		expect(getAnthropicThinkingConfig("claude-fable-5-1", info, 0, "none")).to.deep.equal({ type: "adaptive", display: "summarized" })
		expect(getAnthropicReasoningEffort(info, "none")).to.equal("high")
		expect(getAnthropicReasoningEffort(anthropicModels["claude-haiku-5-5"], "none")).to.equal("medium")
	})

	it("preserves legacy fixed-budget and optional-thinking behavior", () => {
		const id = "claude-haiku-4-5-20251001"
		expect(getAnthropicThinkingConfig(id, anthropicModels[id], 2_048)).to.deep.equal({ type: "enabled", budget_tokens: 2_048 })
		expect(getAnthropicThinkingConfig(id, anthropicModels[id], 0)).to.equal(undefined)
		expect(getAnthropicThinkingConfig("claude-sonnet-4-6", anthropicModels["claude-sonnet-4-6"], undefined)).to.equal(undefined)
	})
})
