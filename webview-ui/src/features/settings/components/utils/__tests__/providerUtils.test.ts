import { type ApiConfiguration, unbiasedDefaultModelId, unbiasedModels } from "@shared/api"
import { describe, expect, it } from "vitest"
import { normalizeApiConfiguration } from "../providerUtils"

describe.each(["plan", "act"] as const)("Unbiased model normalization in %s mode", (mode) => {
	const configuration = (modelId: string | undefined): ApiConfiguration => ({
		planModeApiProvider: "unbiased",
		actModeApiProvider: "unbiased",
		planModeApiModelId: mode === "plan" ? modelId : "pareto-other-mode",
		actModeApiModelId: mode === "act" ? modelId : "pareto-other-mode",
	})

	it.each([
		"pareto-26.9",
		"pareto-26.10-preview",
		"pareto-future-version",
	])("preserves %s without substituting the default model's name or metadata", (modelId) => {
		const result = normalizeApiConfiguration(configuration(modelId), mode)

		expect(result).toEqual({
			selectedProvider: "unbiased",
			selectedModelId: modelId,
			selectedModelInfo: { supportsPromptCache: false },
		})
		expect(result.selectedModelInfo.name || result.selectedModelId).toBe(modelId)
	})

	it("retains the default Pareto model's metadata when explicitly selected", () => {
		expect(normalizeApiConfiguration(configuration("pareto"), mode)).toEqual({
			selectedProvider: "unbiased",
			selectedModelId: unbiasedDefaultModelId,
			selectedModelInfo: unbiasedModels.pareto,
		})
	})

	it.each([
		undefined,
		"",
		"claude-sonnet-4-6",
		"not-pareto-26.10-preview",
	])("defaults missing or unrelated model IDs (%s) to Pareto", (modelId) => {
		expect(normalizeApiConfiguration(configuration(modelId), mode)).toEqual({
			selectedProvider: "unbiased",
			selectedModelId: unbiasedDefaultModelId,
			selectedModelInfo: unbiasedModels.pareto,
		})
	})
})
