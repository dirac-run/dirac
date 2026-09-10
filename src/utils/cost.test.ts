import { describe, it } from "mocha"
import "should"
import { deepSeekModels, isFreeModel, type ModelInfo, openAiNativeModels } from "@shared/api"
import {
	calculateApiCostAnthropic,
	calculateApiCostOpenAI,
	calculateApiCostQwen,
	getModelInfoForInferenceSpeed,
} from "@utils/cost"

describe("Cost Utilities", () => {
	describe("calculateApiCostAnthropic", () => {
		it("should calculate basic input/output costs", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: false,
				inputPrice: 3.0, // $3 per million tokens
				outputPrice: 15.0, // $15 per million tokens
			}

			const cost = calculateApiCostAnthropic(modelInfo, 1000, 500)
			// Input: (3.0 / 1_000_000) * 1000 = 0.003
			// Output: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			cost!.should.equal(0.0105)
		})

		it("should return undefined when prices are missing (unknown pricing)", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				// No prices specified
			}

			const cost = calculateApiCostAnthropic(modelInfo, 1000, 500)
			should.not.exist(cost)
		})

		it("should return 0 when prices are explicitly zero (genuinely free)", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				inputPrice: 0,
				outputPrice: 0,
			}

			const cost = calculateApiCostAnthropic(modelInfo, 1000, 500)
			cost!.should.equal(0)
		})

		it("should use real model configuration (Claude 3.5 Sonnet)", () => {
			const modelInfo: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
			}

			const cost = calculateApiCostAnthropic(modelInfo, 2000, 1000, 1500, 500)
			// Cache writes: (3.75 / 1_000_000) * 1500 = 0.005625
			// Cache reads: (0.3 / 1_000_000) * 500 = 0.00015
			// Input: (3.0 / 1_000_000) * 2000 = 0.006
			// Output: (15.0 / 1_000_000) * 1000 = 0.015
			// Total: 0.005625 + 0.00015 + 0.006 + 0.015 = 0.026775
			cost!.should.equal(0.026775)
		})

		it("should handle zero token counts", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
			}

			const cost = calculateApiCostAnthropic(modelInfo, 0, 0, 0, 0)
			cost!.should.equal(0)
		})
	})

	describe("calculateApiCostOpenAI", () => {
		it("should calculate basic input/output costs", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: false,
				inputPrice: 3.0, // $3 per million tokens
				outputPrice: 15.0, // $15 per million tokens
			}

			const cost = calculateApiCostOpenAI(modelInfo, 1000, 500)
			// Input: (3.0 / 1_000_000) * 1000 = 0.003
			// Output: (15.0 / 1_000_000) * 500 = 0.0075
			// Total: 0.003 + 0.0075 = 0.0105
			cost!.should.equal(0.0105)
		})

		it("should return undefined when prices are missing (unknown pricing)", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				// No prices specified
			}

			const cost = calculateApiCostOpenAI(modelInfo, 1000, 500)
			should.not.exist(cost)
		})

		it("should return 0 when prices are explicitly zero (genuinely free)", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				inputPrice: 0,
				outputPrice: 0,
			}

			const cost = calculateApiCostOpenAI(modelInfo, 1000, 500)
			cost!.should.equal(0)
		})

		it("should use real model configuration (Claude 3.5 Sonnet)", () => {
			const modelInfo: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
			}

			const cost = calculateApiCostOpenAI(modelInfo, 2100, 1000, 1500, 500)
			// Cache writes: (3.75 / 1_000_000) * 1500 = 0.005625
			// Cache reads: (0.3 / 1_000_000) * 500 = 0.00015
			// Input: (3.0 / 1_000_000) * (2100 - 1500 - 500) = 0.0003
			// Output: (15.0 / 1_000_000) * 1000 = 0.015
			// Total: 0.005625 + 0.00015 + 0.0003 + 0.015 = 0.021075
			cost!.should.equal(0.021075)
		})

		it("should handle zero token counts", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				inputPrice: 3.0,
				outputPrice: 15.0,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
			}

			const cost = calculateApiCostOpenAI(modelInfo, 0, 0, 0, 0)
			cost!.should.equal(0)
		})

		it("applies DeepSeek V4.1 Flash peak pricing only during the published UTC windows", () => {
			const modelInfo = deepSeekModels["deepseek-flash"]
			const examples = [
				["2026-09-11T00:59:00Z", 0.6765],
				["2026-09-11T01:00:00Z", 1.353],
				["2026-09-11T03:59:00Z", 1.353],
				["2026-09-11T04:00:00Z", 0.6765],
				["2026-09-11T05:59:00Z", 0.6765],
				["2026-09-11T06:00:00Z", 1.353],
				["2026-09-11T09:59:00Z", 1.353],
				["2026-09-11T10:00:00Z", 0.6765],
				["2026-09-12T07:00:00Z", 0.6765],
			] as const

			for (const [timestamp, expectedCost] of examples) {
				const cost = calculateApiCostOpenAI(
					modelInfo,
					1_000_000,
					1_000_000,
					500_000,
					500_000,
					undefined,
					undefined,
					new Date(timestamp),
				)
				cost!.should.equal(expectedCost)
			}
		})
	})

	describe("getModelInfoForInferenceSpeed", () => {
		it("applies model-specific OpenAI Fast pricing multipliers", () => {
			const terra = getModelInfoForInferenceSpeed(openAiNativeModels["gpt-5.6-terra"], "fast")
			terra.inputPrice!.should.equal(5)
			terra.outputPrice!.should.equal(30)
			terra.cacheReadsPrice!.should.equal(0.5)
			terra.cacheWritesPrice!.should.equal(6.25)

			const luna = getModelInfoForInferenceSpeed(openAiNativeModels["gpt-5.6-luna"], "fast")
			luna.inputPrice!.should.equal(2)
			luna.outputPrice!.should.equal(12)
			luna.cacheReadsPrice!.should.equal(0.2)
			luna.cacheWritesPrice!.should.equal(2.5)
		})
	})

	describe("calculateApiCostQwen", () => {
		it("should calculate basic input/output costs", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: false,
				inputPrice: 0.15, // Qwen 30B pricing
				outputPrice: 0.6,
			}

			const cost = calculateApiCostQwen(modelInfo, 1000, 500)
			// Input: (0.15 / 1_000_000) * 1000 = 0.00015
			// Output: (0.6 / 1_000_000) * 500 = 0.0003
			// Total: 0.00015 + 0.0003 = 0.00045
			cost!.should.equal(0.00045)
		})

		it("should return undefined when prices are missing (unknown pricing)", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				// No prices specified
			}

			const cost = calculateApiCostQwen(modelInfo, 1000, 500)
			should.not.exist(cost)
		})

		it("should return 0 when prices are explicitly zero (genuinely free)", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				inputPrice: 0,
				outputPrice: 0,
			}

			const cost = calculateApiCostQwen(modelInfo, 1000, 500)
			cost!.should.equal(0)
		})

		it("should use real Qwen model configuration (30B)", () => {
			const modelInfo: ModelInfo = {
				maxTokens: 8192,
				contextWindow: 262_144,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0.15,
				outputPrice: 0.6,
			}

			const cost = calculateApiCostQwen(modelInfo, 1000, 500, 0, 0)
			// Input: (0.15 / 1_000_000) * 1000 = 0.00015
			// Output: (0.6 / 1_000_000) * 500 = 0.0003
			// Total: 0.00015 + 0.0003 = 0.00045
			cost!.should.equal(0.00045)
		})

		it("should handle cache tokens correctly (Qwen-style)", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				inputPrice: 0.15,
				outputPrice: 0.6,
				cacheWritesPrice: 0.2,
				cacheReadsPrice: 0.05,
			}

			// Qwen-style: inputTokens includes cached tokens
			const cost = calculateApiCostQwen(modelInfo, 2100, 1000, 1500, 500)
			// Cache writes: (0.2 / 1_000_000) * 1500 = 0.0003
			// Cache reads: (0.05 / 1_000_000) * 500 = 0.000025
			// Input: (0.15 / 1_000_000) * (2100 - 1500 - 500) = 0.000015
			// Output: (0.6 / 1_000_000) * 1000 = 0.0006
			// Total: 0.0003 + 0.000025 + 0.000015 + 0.0006 = 0.00094
			cost!.should.equal(0.00094)
		})

		it("should handle zero token counts", () => {
			const modelInfo: ModelInfo = {
				supportsPromptCache: true,
				inputPrice: 0.15,
				outputPrice: 0.6,
				cacheWritesPrice: 0.2,
				cacheReadsPrice: 0.05,
			}

			const cost = calculateApiCostQwen(modelInfo, 0, 0, 0, 0)
			cost!.should.equal(0)
		})
	})

	describe("isFreeModel", () => {
		it("returns true when input and output prices are zero", () => {
			isFreeModel({ supportsPromptCache: true, inputPrice: 0, outputPrice: 0 }).should.be.true()
		})

		it("returns true when all pricing overrides are explicitly zero", () => {
			isFreeModel({
				supportsPromptCache: true,
				inputPrice: 0,
				outputPrice: 0,
				cacheWritesPrice: 0,
				cacheReadsPrice: 0,
				tiers: [{ contextWindow: 100_000, inputPrice: 0, outputPrice: 0, cacheWritesPrice: 0, cacheReadsPrice: 0 }],
				thinkingConfig: { outputPrice: 0, outputPriceTiers: [{ tokenLimit: 1_000, price: 0 }] },
			}).should.be.true()
		})

		it("returns false for paid models", () => {
			isFreeModel({ supportsPromptCache: true, inputPrice: 3.0, outputPrice: 15.0 }).should.be.false()
		})

		it("returns false for unknown-pricing models", () => {
			isFreeModel({ supportsPromptCache: true }).should.be.false()
		})

		it("returns false when one base price is missing", () => {
			isFreeModel({ supportsPromptCache: true, inputPrice: 0 }).should.be.false()
		})

		it("returns false when cache pricing can add a charge", () => {
			isFreeModel({ supportsPromptCache: true, inputPrice: 0, outputPrice: 0, cacheWritesPrice: 1 }).should.be.false()
			isFreeModel({ supportsPromptCache: true, inputPrice: 0, outputPrice: 0, cacheReadsPrice: 1 }).should.be.false()
		})

		it("returns false when tiered pricing can add a charge", () => {
			const baseModel: ModelInfo = { supportsPromptCache: true, inputPrice: 0, outputPrice: 0 }
			isFreeModel({ ...baseModel, tiers: [{ contextWindow: 100_000, inputPrice: 1 }] }).should.be.false()
			isFreeModel({ ...baseModel, tiers: [{ contextWindow: 100_000, outputPrice: 1 }] }).should.be.false()
			isFreeModel({ ...baseModel, tiers: [{ contextWindow: 100_000, cacheWritesPrice: 1 }] }).should.be.false()
			isFreeModel({ ...baseModel, tiers: [{ contextWindow: 100_000, cacheReadsPrice: 1 }] }).should.be.false()
		})

		it("returns false when thinking pricing can add a charge", () => {
			const baseModel: ModelInfo = { supportsPromptCache: true, inputPrice: 0, outputPrice: 0 }
			isFreeModel({ ...baseModel, thinkingConfig: { outputPrice: 1 } }).should.be.false()
			isFreeModel({
				...baseModel,
				thinkingConfig: { outputPriceTiers: [{ tokenLimit: 1_000, price: 1 }] },
			}).should.be.false()
		})

		// Regression: paid model with totalCost === 0 must not be labeled Free.
		it("paid model with zero tokens is not labeled Free", () => {
			const paidModel: ModelInfo = { supportsPromptCache: true, inputPrice: 3.0, outputPrice: 15.0 }
			const cost = calculateApiCostAnthropic(paidModel, 0, 0, 0, 0)
			cost!.should.equal(0)
			isFreeModel(paidModel).should.be.false()
		})
	})
})
