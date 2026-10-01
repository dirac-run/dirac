import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { createApiConfigurationForModelProviderSelection } from "@core/api"
import { modelProviderSelectionUpdates } from "@core/api/modelProviderSelection"
import type { ApiConfiguration, ModelInfo, ModelProviderSelection } from "@shared/api"

const modelInfo: ModelInfo = { supportsPromptCache: false }

function selection(provider: ModelProviderSelection["provider"], modelId: string): ModelProviderSelection {
	return { provider, modelId, modelInfo }
}

describe("modelProviderSelectionUpdates", () => {
	it("projects dynamic provider model fields without credentials", () => {
		const updates = modelProviderSelectionUpdates("act", selection("openrouter", "openrouter/utility"))

		assert.equal(updates.actModeApiProvider, "openrouter")
		assert.equal(updates.actModeApiModelId, "openrouter/utility")
		assert.equal(updates.actModeOpenRouterModelId, "openrouter/utility")
		assert.deepEqual(updates.actModeOpenRouterModelInfo, modelInfo)
		assert.equal("openRouterApiKey" in updates, false)
	})

	it("projects OpenAI profile, VS Code selector, and Bedrock custom identity", () => {
		const openAi = modelProviderSelectionUpdates("plan", {
			...selection("openai", "custom-model"),
			openAiProfileName: "Internal endpoint",
		})
		assert.equal(openAi.planModeOpenAiModelId, "custom-model")
		assert.equal(openAi.planModeOpenAiProfileName, "Internal endpoint")
		assert.deepEqual(openAi.planModeOpenAiModelInfo, modelInfo)

		const vsCodeSelector = { vendor: "vendor", family: "family" }
		const vsCode = modelProviderSelectionUpdates("act", {
			...selection("vscode-lm", "vscode-model"),
			vsCodeLmModelSelector: vsCodeSelector,
		})
		assert.deepEqual(vsCode.actModeVsCodeLmModelSelector, vsCodeSelector)

		const bedrock = modelProviderSelectionUpdates("act", {
			...selection("bedrock", "anthropic.claude"),
			awsBedrockCustomSelected: true,
			awsBedrockCustomModelBaseId: "anthropic.claude-base",
		})
		assert.equal(bedrock.actModeAwsBedrockCustomSelected, true)
		assert.equal(bedrock.actModeAwsBedrockCustomModelBaseId, "anthropic.claude-base")
	})

	it("preserves Standard for speed-aware providers and clears invalid Fast selections", () => {
		const standard = modelProviderSelectionUpdates("act", selection("anthropic", "claude-opus-4-6"), "standard")
		assert.equal("actModeInferenceSpeed" in standard, false)

		const fast = modelProviderSelectionUpdates("act", selection("anthropic", "claude-opus-4-6"), "fast")
		assert.equal(fast.actModeInferenceSpeed, "default")

		const unsupported = modelProviderSelectionUpdates("act", selection("openrouter", "openrouter/utility"), "standard")
		assert.equal(unsupported.actModeInferenceSpeed, "default")
	})
})

describe("createApiConfigurationForModelProviderSelection", () => {
	it("preserves credentials while isolating selection and runtime settings from active mode state", () => {
		const base: ApiConfiguration = {
			actModeApiProvider: "anthropic",
			actModeApiModelId: "active-model",
			actModeReasoningEffort: "high",
			actModeThinkingBudgetTokens: 4096,
			apiKey: "credential",
			openRouterApiKey: "openrouter-credential",
			ulid: "active-task",
		}

		const configuration = createApiConfigurationForModelProviderSelection(
			base,
			selection("openrouter", "openrouter/utility"),
			{ ulid: "utility-invocation" },
		)

		assert.deepEqual(base, {
			actModeApiProvider: "anthropic",
			actModeApiModelId: "active-model",
			actModeReasoningEffort: "high",
			actModeThinkingBudgetTokens: 4096,
			apiKey: "credential",
			openRouterApiKey: "openrouter-credential",
			ulid: "active-task",
		})
		assert.equal(configuration.openRouterApiKey, "openrouter-credential")
		assert.equal(configuration.actModeApiProvider, "openrouter")
		assert.equal(configuration.actModeOpenRouterModelId, "openrouter/utility")
		assert.equal(configuration.actModeReasoningEffort, undefined)
		assert.equal(configuration.actModeThinkingBudgetTokens, undefined)
		assert.equal(configuration.disableRetries, false)
		assert.equal(configuration.ulid, "utility-invocation")
	})

	it("enables provider retries even when the active runtime disabled them", () => {
		const base: ApiConfiguration = { disableRetries: true }
		const configuration = createApiConfigurationForModelProviderSelection(base, selection("openai-codex", "gpt-6-luna"))

		assert.equal(configuration.disableRetries, false)
		assert.equal(configuration.actModeApiModelId, "gpt-6-luna")
		assert.equal(base.disableRetries, true)
})
})
