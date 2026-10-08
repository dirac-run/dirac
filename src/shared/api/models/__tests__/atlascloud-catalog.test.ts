import { strict as assert } from "node:assert"
import { atlascloudDefaultModelId, atlascloudModels } from "../atlascloud"

describe("Atlas Cloud model catalog", () => {
	it("keeps the default model registered", () => {
		assert.ok(atlascloudModels[atlascloudDefaultModelId])
		assert.strictEqual(atlascloudDefaultModelId, "deepseek-ai/deepseek-v4-flash")
	})

	it("namespaces every id as <lab>/<model>, matching the gateway", () => {
		for (const id of Object.keys(atlascloudModels)) {
			assert.match(id, /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/, `${id} must be a lab-namespaced gateway id`)
		}
	})

	it("never claims an output limit larger than the context window", () => {
		for (const [id, info] of Object.entries(atlascloudModels)) {
			assert.ok(info.maxTokens! <= info.contextWindow!, `${id}: maxTokens exceeds contextWindow`)
		}
	})

	it("only prices prompt caching for models that actually discount cached input", () => {
		for (const [id, info] of Object.entries(atlascloudModels)) {
			if (!info.supportsPromptCache) {
				assert.ok(!("cacheReadsPrice" in info), `${id}: cacheReadsPrice without supportsPromptCache`)
				continue
			}
			const cacheReadsPrice = (info as { cacheReadsPrice?: number }).cacheReadsPrice
			assert.ok(cacheReadsPrice !== undefined, `${id}: supportsPromptCache without cacheReadsPrice`)
			assert.ok(cacheReadsPrice < info.inputPrice!, `${id}: cached input must be cheaper than uncached`)
		}
	})
})
