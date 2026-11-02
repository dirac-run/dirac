import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { filterOpenRouterModelIds, rankModelIdsForDisplay, releaseDateKey } from "../model-filters"

describe("filterOpenRouterModelIds", () => {
	it("hides internal provider entries", () => {
		assert.deepEqual(filterOpenRouterModelIds(["dirac/internal", "z-ai/glm-4.7"], "openrouter"), ["z-ai/glm-4.7"])
	})
})

describe("releaseDateKey", () => {
	it("parses the compact canonical stamp", () => {
		assert.equal(releaseDateKey("z-ai/glm-4.7-20251222"), "20251222")
	})

	it("parses dashed, month-year, and short stamp forms", () => {
		assert.equal(releaseDateKey("qwen/qwen3-coder-next-2025-02-03"), "20250203")
		assert.equal(releaseDateKey("cohere/command-a-plus-05-2026"), "20260501")
		assert.equal(releaseDateKey("mistralai/mistral-small-2603"), "20260301")
	})

	it("returns undefined without a recognisable stamp", () => {
		assert.equal(releaseDateKey(undefined), undefined)
		assert.equal(releaseDateKey(""), undefined)
		assert.equal(releaseDateKey("openai/gpt-audio"), undefined)
	})
})

describe("rankModelIdsForDisplay", () => {
	const canonicalSlugFor = (modelId: string): string | undefined =>
		({
			"~z-ai/glm-latest": "~z-ai/glm-latest",
			"z-ai/glm-6": "z-ai/glm-6-20260601",
			"z-ai/glm-4.7": "z-ai/glm-4.7-20251222",
			"openai/gpt-5.5": "openai/gpt-5.5-20251101",
			"openai/gpt-audio": "openai/gpt-audio",
		})[modelId]

	it("orders aliases, then dated newest-first, then undated, then variants", () => {
		const ranked = rankModelIdsForDisplay(
			["z-ai/glm-5.3:batch", "openai/gpt-audio", "openai/gpt-5.5", "z-ai/glm-4.7", "~z-ai/glm-latest", "z-ai/glm-6"],
			canonicalSlugFor,
		)
		assert.deepEqual(ranked, [
			"~z-ai/glm-latest",
			"z-ai/glm-6",
			"z-ai/glm-4.7",
			"openai/gpt-5.5",
			"openai/gpt-audio",
			"z-ai/glm-5.3:batch",
		])
	})

	it("keeps a dated base model ahead of its suffixed variants", () => {
		const ranked = rankModelIdsForDisplay(["z-ai/glm-4.7:batch", "z-ai/glm-4.7:free", "z-ai/glm-4.7"], canonicalSlugFor)
		assert.deepEqual(ranked, ["z-ai/glm-4.7", "z-ai/glm-4.7:batch", "z-ai/glm-4.7:free"])
	})

	it("is stable for models sharing a release date", () => {
		assert.deepEqual(
			rankModelIdsForDisplay(["vendor/b", "vendor/a"], () => "vendor/shared-20250101"),
			["vendor/a", "vendor/b"],
		)
	})

	it("never adds or drops models when metadata is missing", () => {
		const input = ["vendor/unknown", "vendor/dated"]
		const ranked = rankModelIdsForDisplay(input, () => undefined)
		assert.deepEqual([...ranked].sort(), [...input].sort())
	})

	it("never adds or drops models across mixed tiers", () => {
		const input = ["~b/latest", "a/dated", "a/x:batch", "c/undated"]
		const ranked = rankModelIdsForDisplay(input, canonicalSlugFor)
		assert.equal(ranked.length, input.length)
		assert.deepEqual([...ranked].sort(), [...input].sort())
	})
})
