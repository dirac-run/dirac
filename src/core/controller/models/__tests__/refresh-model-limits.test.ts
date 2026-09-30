import { describe, it } from "mocha"
import sinon from "sinon"
import "should"
import * as fetchAndCacheModelsModule from "../fetchAndCacheModels"
import { refreshBasetenModels } from "../refreshBasetenModels"
import { refreshGroqModels } from "../refreshGroqModels"

/**
 * Model limits (maxTokens/contextWindow) treat an API 0 as "not provided" and
 * fall back to the static catalog or 8192 — deliberately `||`, not `??`.
 */
describe("model refresh limit fallbacks", () => {
	const controller = () => ({
		stateManager: { getSecretKey: () => "k", getGlobalSettingsKey: () => undefined },
	})

	afterEach(() => {
		sinon.restore()
	})

	function stubFetchAndCache(fixture: unknown) {
		sinon
			.stub(fetchAndCacheModelsModule, "fetchAndCacheModels")
			.callsFake(async (config) => config.parseResponse(fixture) as any)
	}

	describe("Groq", () => {
		it("falls back to the static limits when the API returns 0", async () => {
			stubFetchAndCache([{ object: "model", id: "openai/gpt-oss-120b", max_completion_tokens: 0, context_window: 0 }])
			const models = await refreshGroqModels(controller() as any)
			models["openai/gpt-oss-120b"].maxTokens!.should.equal(32_766)
			models["openai/gpt-oss-120b"].contextWindow!.should.equal(131_072)
		})

		it("falls back to 8192 when the API returns 0 for an unknown model", async () => {
			stubFetchAndCache([{ object: "model", id: "acme/new-model", max_completion_tokens: 0, context_window: 0 }])
			const models = await refreshGroqModels(controller() as any)
			models["acme/new-model"].maxTokens!.should.equal(8192)
			models["acme/new-model"].contextWindow!.should.equal(8192)
		})

		it("uses positive API limits as-is", async () => {
			stubFetchAndCache([{ object: "model", id: "acme/big-model", max_completion_tokens: 50_000, context_window: 200_000 }])
			const models = await refreshGroqModels(controller() as any)
			models["acme/big-model"].maxTokens!.should.equal(50_000)
			models["acme/big-model"].contextWindow!.should.equal(200_000)
		})

		it("falls back to static limits or 8192 when the API value is absent", async () => {
			stubFetchAndCache([
				{ object: "model", id: "openai/gpt-oss-20b" },
				{ object: "model", id: "acme/bare" },
			])
			const models = await refreshGroqModels(controller() as any)
			models["openai/gpt-oss-20b"].maxTokens!.should.equal(32_766)
			models["openai/gpt-oss-20b"].contextWindow!.should.equal(131_072)
			models["acme/bare"].maxTokens!.should.equal(8192)
			models["acme/bare"].contextWindow!.should.equal(8192)
		})

		it("describes a context_window of 0 as 8,192 tokens", async () => {
			stubFetchAndCache([{ object: "model", id: "acme/zero-ctx", context_window: 0 }])
			const models = await refreshGroqModels(controller() as any)
			models["acme/zero-ctx"].description!.should.containEql("8,192")
		})
	})

	describe("Baseten", () => {
		it("falls back to the static limits when the API returns 0", async () => {
			stubFetchAndCache([{ object: "model", id: "deepseek-ai/DeepSeek-R1", max_completion_tokens: 0, context_length: 0 }])
			const models = await refreshBasetenModels(controller() as any)
			models["deepseek-ai/DeepSeek-R1"].maxTokens!.should.equal(131_072)
			models["deepseek-ai/DeepSeek-R1"].contextWindow!.should.equal(163_840)
		})

		it("falls back to 8192 when the API returns 0 for a model without static limits", async () => {
			stubFetchAndCache([{ object: "model", id: "acme/zero-model", max_completion_tokens: 0, context_length: 0 }])
			const models = await refreshBasetenModels(controller() as any)
			models["acme/zero-model"].maxTokens!.should.equal(8192)
			models["acme/zero-model"].contextWindow!.should.equal(8192)
		})

		it("uses positive API limits as-is and static limits when absent", async () => {
			stubFetchAndCache([
				{ object: "model", id: "acme/big", max_completion_tokens: 9_000, context_length: 90_000 },
				{ object: "model", id: "deepseek-ai/DeepSeek-R1" },
			])
			const models = await refreshBasetenModels(controller() as any)
			models["acme/big"].maxTokens!.should.equal(9_000)
			models["acme/big"].contextWindow!.should.equal(90_000)
			models["deepseek-ai/DeepSeek-R1"].maxTokens!.should.equal(131_072)
			models["deepseek-ai/DeepSeek-R1"].contextWindow!.should.equal(163_840)
		})
	})
})
