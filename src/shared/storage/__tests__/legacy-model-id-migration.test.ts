import { expect } from "chai"
import { describe, it } from "mocha"
import {
	buildLegacyAnthropicFastModeStateUpdates,
	buildRetiredDeepSeekModelStateUpdates,
	buildLegacyModelIdStateUpdates,
	buildLegacySynthetic1mStateUpdates,
	normalizeLegacyOpenRouterPinMap,
	normalizeLegacySynthetic1mModelId,
	normalizeRetiredDeepSeekModelId,
} from "../legacy-model-id-migration"

describe("legacy synthetic 1m model-id migration", () => {
	it("normalizes plain, fast-mode, and preset IDs idempotently", () => {
		const examples = [
			["model:1m", "model"],
			["model:1m:fast", "model:fast"],
			["author/model:1m@preset/team", "author/model@preset/team"],
			["author/model", "author/model"],
		]

		for (const [legacy, canonical] of examples) {
			expect(normalizeLegacySynthetic1mModelId(legacy)).to.equal(canonical)
			expect(normalizeLegacySynthetic1mModelId(canonical)).to.equal(canonical)
		}
	})

	it("merges canonical pin tags before sorted legacy keys and removes duplicates", () => {
		expect(
			normalizeLegacyOpenRouterPinMap({
				"author/model:1m": ["legacy-a", "shared"],
				"author/model": ["canonical", "shared"],
				"author/model:1m@preset/team": ["preset"],
			}),
		).to.deep.equal({
			"author/model": ["canonical", "shared", "legacy-a"],
			"author/model@preset/team": ["preset"],
		})
	})

	it("normalizes saved selections and model-provider presets together", () => {
		const updates = buildLegacySynthetic1mStateUpdates({
			actModeOpenRouterModelId: "author/model:1m",
			modelProviderPresets: [
				{
					id: "openrouter::author%2Fmodel%3A1m",
					provider: "openrouter",
					modelId: "author/model:1m",
					modelInfo: { contextWindow: 1_000_000, supportsPromptCache: true },
					lastUsedAt: 1,
				},
			],
		})
		const [preset] = updates.modelProviderPresets!

		expect(updates.actModeOpenRouterModelId).to.equal("author/model")
		expect(preset.modelId).to.equal("author/model")
		expect(preset.id).to.equal("openrouter::author%2Fmodel")
		expect(preset.modelInfo).to.equal(undefined)
	})
})


describe("legacy Anthropic fast-mode migration", () => {
	it("moves supported synthetic IDs to the base model and Fast setting", () => {
		expect(
			buildLegacyAnthropicFastModeStateUpdates({
				planModeApiModelId: "claude-opus-4-8:fast",
				actModeApiModelId: "claude-opus-5:fast",
			}),
		).to.deep.equal({
			planModeApiModelId: "claude-opus-4-8",
			planModeInferenceSpeed: "fast",
			actModeApiModelId: "claude-opus-5",
			actModeInferenceSpeed: "fast",
		})
	})

	it("disables Fast for obsolete synthetic IDs", () => {
		expect(buildLegacyAnthropicFastModeStateUpdates({ actModeApiModelId: "claude-opus-4-6:fast" })).to.deep.equal({
			actModeApiModelId: "claude-opus-4-6",
			actModeInferenceSpeed: "standard",
		})
	})

	it("migrates combined synthetic context and Fast suffixes in sequence", () => {
		expect(buildLegacyModelIdStateUpdates({ actModeApiModelId: "claude-opus-4-8:1m:fast" })).to.deep.equal({
			actModeApiModelId: "claude-opus-4-8",
			actModeInferenceSpeed: "fast",
		})
	})

	it("removes retired Fast suffixes from model/provider presets", () => {
		const [preset] = buildLegacySynthetic1mStateUpdates({
			modelProviderPresets: [
				{
					id: "anthropic::claude-opus-4-8%3Afast",
					provider: "anthropic",
					modelId: "claude-opus-4-8:fast",
					modelInfo: { supportsPromptCache: true },
					lastUsedAt: 1,
				},
			],
		}).modelProviderPresets!
		expect(preset.modelId).to.equal("claude-opus-4-8")
		expect(preset.id).to.equal("anthropic::claude-opus-4-8")
		expect(preset.modelInfo).to.equal(undefined)
	})
})

describe("retired DeepSeek model migration", () => {
	it("normalizes retired IDs and leaves the canonical ID unchanged", () => {
		for (const modelId of [
			"deepseek-v4-flash",
			"deepseek-v4-flash-vision-exp",
			"deepseek-v4-pro",
			"deepseek-chat",
			"deepseek-reasoner",
		]) {
			expect(normalizeRetiredDeepSeekModelId(modelId)).to.equal("deepseek-flash")
		}
		expect(normalizeRetiredDeepSeekModelId("deepseek-flash")).to.equal("deepseek-flash")
	})

	it("only migrates mode selections owned by the DeepSeek provider", () => {
		expect(
			buildRetiredDeepSeekModelStateUpdates({
				planModeApiProvider: "deepseek",
				planModeApiModelId: "deepseek-v4-pro",
				actModeApiProvider: "openai-native",
				actModeApiModelId: "deepseek-chat",
			}),
		).to.deep.equal({ planModeApiModelId: "deepseek-flash" })
	})

	it("migrates a saved DeepSeek utility-model selection", () => {
		expect(
			buildRetiredDeepSeekModelStateUpdates({
				utilityModelSelection: {
					provider: "deepseek",
					modelId: "deepseek-reasoner",
					modelInfo: { supportsPromptCache: true },
				},
			}),
		).to.deep.equal({
			utilityModelSelection: {
				provider: "deepseek",
				modelId: "deepseek-flash",
				modelInfo: undefined,
			},
		})
	})
	it("migrates DeepSeek model-provider presets", () => {
		const [preset] = buildLegacySynthetic1mStateUpdates({
			modelProviderPresets: [
				{
					id: "deepseek::deepseek-v4-pro",
					provider: "deepseek",
					modelId: "deepseek-v4-pro",
					modelInfo: { supportsPromptCache: true },
					lastUsedAt: 1,
				},
			],
		}).modelProviderPresets!
		expect(preset.modelId).to.equal("deepseek-flash")
		expect(preset.id).to.equal("deepseek::deepseek-flash")
		expect(preset.modelInfo).to.equal(undefined)
	})
})