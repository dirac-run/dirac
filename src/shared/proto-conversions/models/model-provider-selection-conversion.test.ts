import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { ModelProviderSelection } from "@shared/api"
import { ModelProviderSelection as ProtoModelProviderSelection } from "@shared/proto/dirac/state"
import { convertModelProviderSelectionToProto, convertProtoToModelProviderSelection } from "./api-configuration-conversion"

function roundTrip(selection: ModelProviderSelection): ModelProviderSelection {
	const proto = convertModelProviderSelectionToProto(selection)
	const encoded = ProtoModelProviderSelection.encode(proto).finish()
	return convertProtoToModelProviderSelection(ProtoModelProviderSelection.decode(encoded))
}

describe("independent model selection protobuf conversion", () => {
	for (const reasoningEffort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		it(`round trips ${reasoningEffort} reasoning and an explicit zero budget`, () => {
			const selection: ModelProviderSelection = {
				provider: "openai",
				modelId: "custom-model",
				openAiProfileName: "Local workstation",
				reasoningEffort,
				thinkingBudgetTokens: 0,
				geminiThinkingLevel: "low",
			}
			const restored = roundTrip(selection)
			assert.equal(restored.provider, selection.provider)
			assert.equal(restored.modelId, selection.modelId)
			assert.equal(restored.openAiProfileName, selection.openAiProfileName)
			assert.equal(restored.reasoningEffort, reasoningEffort)
			assert.equal(restored.thinkingBudgetTokens, 0)
			assert.equal(restored.geminiThinkingLevel, "low")
		})
	}

	it("round trips a selected positive thinking budget and provider-specific identity", () => {
		const restored = roundTrip({
			provider: "bedrock",
			modelId: "custom-model",
			awsBedrockCustomSelected: false,
			awsBedrockCustomModelBaseId: "base-model",
			vsCodeLmModelSelector: { vendor: "vendor", family: "family" },
			thinkingBudgetTokens: 8192,
		})
		assert.equal(restored.thinkingBudgetTokens, 8192)
		assert.equal(restored.awsBedrockCustomSelected, false)
		assert.equal(restored.awsBedrockCustomModelBaseId, "base-model")
		assert.equal(restored.vsCodeLmModelSelector?.vendor, "vendor")
		assert.equal(restored.vsCodeLmModelSelector?.family, "family")
	})

	it("preserves an explicit zero temperature in LiteLLM selection metadata", () => {
		const restored = roundTrip({
			provider: "litellm",
			modelId: "custom-model",
			modelInfo: { supportsPromptCache: false, temperature: 0 },
		})
		assert.equal(restored.modelInfo?.temperature, 0)
	})

	it("keeps legacy absent reasoning absent rather than supplying defaults", () => {
		const restored = roundTrip({ provider: "anthropic", modelId: "claude-model" })
		assert.equal(restored.reasoningEffort, undefined)
		assert.equal(restored.thinkingBudgetTokens, undefined)
		assert.equal(restored.geminiThinkingLevel, undefined)
	})

	it("does not serialize credentials accidentally attached to an input selection", () => {
		const selection = {
			provider: "openai" as const,
			modelId: "custom-model",
			openAiProfileName: "Local workstation",
			apiKey: "secret-key",
			openAiApiKey: "endpoint-secret-key",
			openAiBaseUrl: "https://private.example.test",
		}
		const proto = convertModelProviderSelectionToProto(selection)
		const restored = roundTrip(selection)
		for (const value of [proto, restored]) {
			assert.equal("apiKey" in value, false)
			assert.equal("openAiApiKey" in value, false)
			assert.equal("openAiBaseUrl" in value, false)
		}
		assert.equal(restored.openAiProfileName, "Local workstation")
	})
})
