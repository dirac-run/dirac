import axios from "axios"
import { describe, it } from "mocha"
import sinon from "sinon"
import "should"
import * as fetchAndCacheModelsModule from "../fetchAndCacheModels"
import { refreshBasetenModels } from "../refreshBasetenModels"
import { refreshRequestyModels } from "../refreshRequestyModels"
import { refreshVercelAiGatewayModels } from "../refreshVercelAiGatewayModels"

/**
 * Pricing "0" is a real free price for Requesty/Vercel (`??` fallbacks), while
 * Baseten keeps master's `||` semantics: a 0 falls back to the static catalog
 * price. Baseten/Vercel are exercised through the exported refresh fn with
 * fetchAndCacheModels stubbed; Requesty through axios.
 */
describe("model refresh pricing", () => {
	afterEach(() => {
		sinon.restore()
	})

	const controller = () => ({
		stateManager: { getSecretKey: () => "k", getGlobalSettingsKey: () => undefined },
	})

	// Drives the refresh fn through its real parseResponse callback.
	function stubFetchAndCache(fixture: unknown) {
		sinon
			.stub(fetchAndCacheModelsModule, "fetchAndCacheModels")
			.callsFake(async (config) => config.parseResponse(fixture) as any)
	}

	it("Baseten falls back to the static price when the API returns 0", async () => {
		stubFetchAndCache([{ object: "model", id: "moonshotai/Kimi-K2-Thinking", pricing: { prompt: "0", completion: "0" } }])
		const models = await refreshBasetenModels(controller() as any)
		// Baseten uses `||` so a 0 falls through to the static catalog price 0.6/2.5.
		models["moonshotai/Kimi-K2-Thinking"].inputPrice!.should.equal(0.6)
		models["moonshotai/Kimi-K2-Thinking"].outputPrice!.should.equal(2.5)
	})

	it("Baseten falls back to the static price when the API price is absent or invalid", async () => {
		stubFetchAndCache([
			{ object: "model", id: "moonshotai/Kimi-K2-Thinking" },
			{ object: "model", id: "zai-org/GLM-4.6", pricing: { prompt: "abc" } },
		])
		const models = await refreshBasetenModels(controller() as any)
		models["moonshotai/Kimi-K2-Thinking"].inputPrice!.should.equal(0.6)
		const invalid = models["zai-org/GLM-4.6"].inputPrice!
		Number.isNaN(invalid).should.be.false()
		invalid.should.equal(0.6)
	})

	it("Requesty maps explicit 0 to 0 and invalid/absent to 0 without NaN", async () => {
		sinon.stub(axios, "get").resolves({
			data: {
				data: [
					{ id: "m/free", input_price: "0", output_price: "0", context_window: 1 },
					{ id: "m/invalid", input_price: "abc", output_price: undefined, context_window: 1 },
				],
			},
		})
		const result = await refreshRequestyModels(controller() as any, {} as any)
		const models = result.models as Record<string, any>
		models["m/free"].inputPrice.should.equal(0)
		models["m/free"].outputPrice.should.equal(0)
		Number.isNaN(models["m/invalid"].inputPrice).should.be.false()
		models["m/invalid"].inputPrice.should.equal(0)
		models["m/invalid"].outputPrice.should.equal(0)
	})

	it("Vercel maps explicit 0 to 0 and invalid price to 0 without NaN", async () => {
		stubFetchAndCache([
			{ id: "openai/o1", pricing: { input: "0", output: "0" } },
			{ id: "google/gemini-3", pricing: { input: "abc" } },
		])
		const models = await refreshVercelAiGatewayModels(controller() as any)
		models["openai/o1"].inputPrice!.should.equal(0)
		models["openai/o1"].outputPrice!.should.equal(0)
		Number.isNaN(models["google/gemini-3"].inputPrice!).should.be.false()
		models["google/gemini-3"].inputPrice!.should.equal(0)
	})
})
