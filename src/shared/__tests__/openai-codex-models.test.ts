import { describe, it } from "mocha"
import "should"
import {
	openAiCodexDefaultModelId,
	openAiCodexModels,
	openAiNativeDefaultModelId,
	openAiNativeModels,
} from "../api"

describe("openAiCodexModels", () => {
	it("includes supported GPT-5 and GPT-6 variants available through ChatGPT Codex auth", () => {
		Object.keys(openAiCodexModels).should.deepEqual([
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.4-nano",
			"gpt-5.4-pro",
			"gpt-5.6-sol",
			"gpt-6-astra",
			"gpt-6-sol",
			"gpt-6.1-sol",
			"gpt-6.1-terra",
			"gpt-6-luna",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		])
	})

	it("uses GPT-6 Astra as the OpenAI Native and Codex default", () => {
		openAiNativeDefaultModelId.should.equal("gpt-6-astra")
		openAiCodexDefaultModelId.should.equal("gpt-6-astra")
	})

	it("defines GPT-5.5 metadata", () => {
		openAiCodexModels["gpt-5.5"].contextWindow!.should.equal(1_050_000)
		openAiCodexModels["gpt-5.5"].maxTokens!.should.equal(128_000)
		openAiCodexModels["gpt-5.5"].supportsReasoning!.should.equal(true)
		openAiCodexModels["gpt-5.5"].description!.should.containEql("Dec 01, 2025")
	})

	it("configures GPT-6 Astra like GPT-5.6 Sol", () => {
		const nativeAstra = openAiNativeModels["gpt-6-astra"]
		const nativeSol = openAiNativeModels["gpt-5.6-sol"]
		nativeAstra.maxTokens!.should.equal(nativeSol.maxTokens!)
		nativeAstra.contextWindow!.should.equal(nativeSol.contextWindow!)
		nativeAstra.inputPrice.should.equal(nativeSol.inputPrice)
		nativeAstra.outputPrice.should.equal(nativeSol.outputPrice)
		nativeAstra.fastModePriceMultiplier.should.equal(nativeSol.fastModePriceMultiplier)
		nativeAstra.supportsPersistedReasoning.should.equal(true)

		const codexAstra = openAiCodexModels["gpt-6-astra"]
		codexAstra.maxTokens!.should.equal(openAiCodexModels["gpt-5.6-sol"].maxTokens!)
		codexAstra.supportsPersistedReasoning.should.equal(true)
	})

	it("defines GPT-6 Sol and Luna capabilities and pricing", () => {
		const nativeSol = openAiNativeModels["gpt-6-sol"]
		nativeSol.contextWindow!.should.equal(1_050_000)
		nativeSol.maxTokens!.should.equal(128_000)
		nativeSol.reasoningEffortOptions!.should.deepEqual(["none", "low", "medium", "high", "xhigh", "max"])
		nativeSol.defaultReasoningEffort!.should.equal("medium")
		nativeSol.inputPrice.should.equal(2)
		nativeSol.outputPrice.should.equal(10)
		nativeSol.cacheReadsPrice.should.equal(0.2)
		nativeSol.cacheWritesPrice.should.equal(2.5)
		nativeSol.tiers[1]!.inputPrice.should.equal(4)
		nativeSol.tiers[1]!.outputPrice.should.equal(15)

		const nativeLuna = openAiNativeModels["gpt-6-luna"]
		nativeLuna.contextWindow!.should.equal(1_050_000)
		nativeLuna.defaultReasoningEffort!.should.equal("medium")
		nativeLuna.inputPrice.should.equal(0.1)
		nativeLuna.outputPrice.should.equal(0.5)
		nativeLuna.cacheReadsPrice.should.equal(0.01)
		nativeLuna.cacheWritesPrice.should.equal(0.125)
		nativeLuna.tiers[1]!.inputPrice.should.equal(0.2)
		nativeLuna.tiers[1]!.outputPrice.should.equal(0.75)

		openAiCodexModels["gpt-6-sol"].supportsPersistedReasoning.should.equal(true)
		openAiCodexModels["gpt-6-luna"].supportsPersistedReasoning.should.equal(true)
	})

	it("defines GPT-6.1 Sol capabilities and distinct cached-input pricing", () => {
		const nativeSol = openAiNativeModels["gpt-6.1-sol"]
		nativeSol.contextWindow!.should.equal(1_050_000)
		nativeSol.maxTokens!.should.equal(128_000)
		nativeSol.supportsImages!.should.equal(true)
		nativeSol.supportsStrictTools!.should.equal(true)
		nativeSol.supportsPersistedReasoning.should.equal(true)
		nativeSol.reasoningEffortOptions!.should.deepEqual(["low", "medium", "high", "xhigh", "max"])
		nativeSol.defaultReasoningEffort!.should.equal("medium")
		nativeSol.supportsFastMode.should.equal(true)
		nativeSol.fastModePriceMultiplier.should.equal(2)
		nativeSol.inputPrice.should.equal(2)
		nativeSol.outputPrice.should.equal(10)
		nativeSol.cacheReadsPrice.should.equal(0.1)
		nativeSol.cacheWritesPrice.should.equal(2.5)
		nativeSol.tiers[0]!.contextWindow.should.equal(272_000)
		nativeSol.tiers[1]!.inputPrice.should.equal(4)
		nativeSol.tiers[1]!.outputPrice.should.equal(15)
		nativeSol.tiers[1]!.cacheReadsPrice.should.equal(0.2)
		nativeSol.tiers[1]!.cacheWritesPrice.should.equal(5)

		const codexSol = openAiCodexModels["gpt-6.1-sol"]
		codexSol.reasoningEffortOptions!.should.deepEqual(nativeSol.reasoningEffortOptions!)
		codexSol.supportsPersistedReasoning.should.equal(true)
		codexSol.inputPrice.should.equal(0)
		codexSol.outputPrice.should.equal(0)
	})

	it("defines GPT-6.1 Terra as a Codex-only model mirroring GPT-6.1 Sol reasoning", () => {
		const codexSol = openAiCodexModels["gpt-6.1-sol"]
		const codexTerra = openAiCodexModels["gpt-6.1-terra"]
		codexTerra.maxTokens!.should.equal(codexSol.maxTokens!)
		codexTerra.contextWindow!.should.equal(codexSol.contextWindow!)
		codexTerra.reasoningEffortOptions!.should.deepEqual(codexSol.reasoningEffortOptions!)
		codexTerra.supportsPersistedReasoning.should.equal(true)
		codexTerra.supportsFastMode.should.equal(true)
		codexTerra.inputPrice.should.equal(0)
		codexTerra.outputPrice.should.equal(0)
	})
})
