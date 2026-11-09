import { describe, it } from "mocha"
import { expect } from "chai"
import { openAiCodexModels, openAiNativeModels } from "../api"
import { ApiFormat } from "../proto/dirac/models"
import { calculateApiCostOpenAI, getModelInfoForInferenceSpeed } from "../../utils/cost"

const modelId = "gpt-6.1-terra"

describe("GPT-6.1 Terra catalogs", () => {
	for (const [provider, models] of [["OpenAI native", openAiNativeModels], ["Codex", openAiCodexModels]] as const) {
		it(`registers Terra's capabilities for ${provider} without selecting Chat Completions`, () => {
			const model = models[modelId]
			expect(model.name).to.equal("GPT-6.1 Terra")
			expect(model.contextWindow).to.equal(1_050_000)
			expect(model.maxTokens).to.equal(128_000)
			expect(model.supportsImages).to.equal(true)
			expect(model.supportsReasoning).to.equal(true)
			expect(model.supportsReasoningEffort).to.equal(true)
			expect(model.reasoningEffortOptions).to.deep.equal(["none", "low", "medium", "high", "xhigh", "max"])
			expect(model.defaultReasoningEffort).to.equal("medium")
			expect(model.supportsTools).to.equal(true)
			expect(model.supportsStrictTools).to.equal(true)
			expect(model.supportsPromptCache).to.equal(true)
			expect(model.supportsFastMode).to.equal(true)
			expect(model.supportsPersistedReasoning).to.equal(true)
			expect(model.apiFormat).to.equal(ApiFormat.OPENAI_RESPONSES)
			expect(model.description).to.include("Jun 01, 2026")
		})
	}

	it("defines Standard pricing and the full-request long-context surcharge", () => {
		const model = openAiNativeModels[modelId]
		expect(model.inputPrice).to.equal(1)
		expect(model.outputPrice).to.equal(5)
		expect(model.cacheReadsPrice).to.equal(0.05)
		expect(model.cacheWritesPrice).to.equal(1.25)
		expect(model.fastModePriceMultiplier).to.equal(2)
		expect(model.tiers).to.deep.equal([
			{ contextWindow: 272_000, inputPrice: 1, outputPrice: 5, cacheWritesPrice: 1.25, cacheReadsPrice: 0.05 },
			{ contextWindow: Number.MAX_SAFE_INTEGER, inputPrice: 2, outputPrice: 7.5, cacheWritesPrice: 2.5, cacheReadsPrice: 0.1 },
		])
	})

	for (const [inputTokens, standardCost] of [[272_000, 0.2605], [272_001, 0.518502]]) {
		it(`bills cached input, cache writes, and output at the full-request tier for ${inputTokens} input tokens`, () => {
			const model = openAiNativeModels[modelId]
			expect(calculateApiCostOpenAI(model, inputTokens!, 1_000, 10_000, 20_000)).to.be.closeTo(standardCost!, 1e-10)
			const fastModel = getModelInfoForInferenceSpeed(model, "fast")
			expect(calculateApiCostOpenAI(fastModel, inputTokens!, 1_000, 10_000, 20_000)).to.be.closeTo(standardCost! * 2, 1e-10)
		})
	}

	it("does not assign API token charges to Codex subscription usage", () => {
		const model = openAiCodexModels[modelId]
		expect(model.inputPrice).to.equal(0)
		expect(model.outputPrice).to.equal(0)
		expect(calculateApiCostOpenAI(model, 300_000, 1_000)).to.equal(0)
	})
})
