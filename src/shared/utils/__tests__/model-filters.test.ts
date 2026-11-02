import { describe, expect, it } from "vitest"
import { filterOpenRouterModelIds, rankModelIdsForDisplay, releaseDateKey } from "../model-filters"

describe("filterOpenRouterModelIds", () => {
	it("hides internal provider entries", () => {
		expect(filterOpenRouterModelIds(["dirac/internal", "z-ai/glm-4.7"], "openrouter")).toEqual(["z-ai/glm-4.7"])
	})
})

describe("releaseDateKey", () => {
	it("parses the compact canonical stamp", () => {
		expect(releaseDateKey("z-ai/glm-4.7-20251222")).toBe("20251222")
	})

	it("parses dashed, month-year, and short stamp forms", () => {
		expect(releaseDateKey("qwen/qwen3-coder-next-2025-02-03")).toBe("20250203")
		expect(releaseDateKey("cohere/command-a-plus-05-2026")).toBe("20260501")
		expect(releaseDateKey("mistralai/mistral-small-2603")).toBe("20260301")
	})

	it("returns undefined without a recognisable stamp", () => {
		expect(releaseDateKey(undefined)).toBeUndefined()
		expect(releaseDateKey("")).toBeUndefined()
		expect(releaseDateKey("openai/gpt-audio")).toBeUndefined()
	})
})

describe("rankModelIdsForDisplay", () => {
	const canonical = (id: string): string | undefined =>
		({
			"~z-ai/glm-latest": "~z-ai/glm-latest",
			"z-ai/glm-6": "z-ai/glm-6-20260601",
			"z-ai/glm-4.7": "z-ai/glm-4.7-20251222",
			"openai/gpt-5.5": "openai/gpt-5.5-20251101",
			"openai/gpt-audio": "openai/gpt-audio",
		})[id]

	it("orders aliases, then dated newest-first, then undated, then variants", () => {
		const ranked = rankModelIdsForDisplay(
			[
				"z-ai/glm-5.3:batch",
				"openai/gpt-audio",
				"openai/gpt-5.5",
				"z-ai/glm-4.7",
				"~z-ai/glm-latest",
				"z-ai/glm-6",
			],
			canonical,
		)
		expect(ranked).toEqual([
			"~z-ai/glm-latest",
			"z-ai/glm-6",
			"z-ai/glm-4.7",
			"openai/gpt-5.5",
			"openai/gpt-audio",
			"z-ai/glm-5.3:batch",
		])
	})

	it("keeps a dated base model ahead of its suffixed variants", () => {
		const ranked = rankModelIdsForDisplay(["z-ai/glm-4.7:batch", "z-ai/glm-4.7:free", "z-ai/glm-4.7"], canonical)
		expect(ranked).toEqual(["z-ai/glm-4.7", "z-ai/glm-4.7:batch", "z-ai/glm-4.7:free"])
	})

	it("is stable for models sharing a release date", () => {
		expect(rankModelIdsForDisplay(["vendor/b", "vendor/a"], () => "vendor/shared-20250101")).toEqual([
			"vendor/a",
			"vendor/b",
		])
	})

	it("keeps every model when metadata is missing", () => {
		const input = ["vendor/unknown", "vendor/dated"]
		expect(rankModelIdsForDisplay(input, () => undefined)).toEqual(input)
	})

	it("never adds or drops models", () => {
		const input = ["~b/latest", "a/dated", "a/x:batch", "c/undated"]
		const ranked = rankModelIdsForDisplay(input, canonical)
		expect(ranked).toHaveLength(input.length)
		expect([...ranked].sort()).toEqual([...input].sort())
	})
})
