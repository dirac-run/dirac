import { strict as assert } from "node:assert"
import { nebiusDefaultModelId, nebiusModels } from "../nebius"

describe("Nebius model catalog (FB-205)", () => {
	it("registers the Kimi models with isR1FormatRequired for reasoning/tool message formatting", () => {
		const kimiK26 = nebiusModels["moonshotai/Kimi-K2.6"]
		const kimiK3 = nebiusModels["moonshotai/Kimi-K3"]

		assert.ok(kimiK26, "moonshotai/Kimi-K2.6 must be registered")
		assert.ok(kimiK3, "moonshotai/Kimi-K3 must be registered")
		assert.strictEqual(kimiK26.isR1FormatRequired, true)
		assert.strictEqual(kimiK3.isR1FormatRequired, true)
	})

	it("registers all GLM models with tool support", () => {
		const glm51 = nebiusModels["zai-org/GLM-5.1"]
		const glm52 = nebiusModels["zai-org/GLM-5.2"]
		const glm53Flash = nebiusModels["zai-org/GLM-5.3-Flash"]

		assert.ok(glm51)
		assert.ok(glm52)
		assert.ok(glm53Flash)
		assert.strictEqual(glm51.supportsTools, true)
		assert.strictEqual(glm52.supportsTools, true)
		assert.strictEqual(glm53Flash.supportsTools, true)
	})

	it("keeps the default model registered", () => {
		assert.ok(nebiusModels[nebiusDefaultModelId])
		assert.strictEqual(nebiusDefaultModelId, "openai/gpt-oss-120b")
	})
})
