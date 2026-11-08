import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { buildApiHandler, buildApiHandlerForSelection, createApiConfigurationForModelProviderSelection } from "@core/api"
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

	for (const mode of ["plan", "act"] as const) {
		it(`projects explicit reasoning off/zero only into ${mode} fields`, () => {
			const independent: ModelProviderSelection = {
				...selection("gemini", "gemini-model"),
				reasoningEffort: "none",
				thinkingBudgetTokens: 0,
				geminiThinkingLevel: "low",
			}
			const original = structuredClone(independent)
			const updates = modelProviderSelectionUpdates(mode, independent)
			const prefix = mode === "plan" ? "planMode" : "actMode"
			assert.deepEqual(updates, {
				[`${prefix}ApiProvider`]: "gemini",
				[`${prefix}ApiModelId`]: "gemini-model",
				[`${prefix}ReasoningEffort`]: "none",
				[`${prefix}ThinkingBudgetTokens`]: 0,
				[`gemini${mode === "plan" ? "Plan" : "Act"}ModeThinkingLevel`]: "low",
			})
			assert.deepEqual(independent, original)
		})

		it(`explicitly clears omitted ${mode} reasoning rather than inheriting it`, () => {
			const updates = modelProviderSelectionUpdates(mode, selection("gemini", "gemini-model"))
			const prefix = mode === "plan" ? "planMode" : "actMode"
			for (const key of [
				`${prefix}ReasoningEffort`,
				`${prefix}ThinkingBudgetTokens`,
				`gemini${mode === "plan" ? "Plan" : "Act"}ModeThinkingLevel`,
			]) {
				assert.equal(Object.hasOwn(updates, key), true)
				assert.equal(updates[key as keyof ApiConfiguration], undefined)
			}
		})
	}

	it("preserves Standard for speed-aware providers and clears invalid Fast selections", () => {
		const standard = modelProviderSelectionUpdates("act", selection("anthropic", "claude-opus-4-6"), "standard")
		assert.equal("actModeInferenceSpeed" in standard, false)

		const fast = modelProviderSelectionUpdates("act", selection("anthropic", "claude-opus-4-6"), "fast")
		assert.equal(fast.actModeInferenceSpeed, "default")

		const unsupported = modelProviderSelectionUpdates("act", selection("openrouter", "openrouter/utility"), "standard")
		assert.equal(unsupported.actModeInferenceSpeed, "default")
	})
})

describe("LM Studio selection context", () => {
	const selected: ModelProviderSelection = {
		provider: "lmstudio", modelId: "local-model", modelInfo: { supportsPromptCache: false, contextWindow: 32768 },
	}
	for (const mode of ["plan", "act"] as const) {
		it(`projects discovered context into the persisted ${mode} configuration`, () => {
			const patch = modelProviderSelectionUpdates(mode, selected)
			assert.equal(patch.lmStudioMaxTokens, "32768")
			assert.equal(buildApiHandler(patch, mode).getModel().info.contextWindow, 32768)
		})
	}
	it("uses independent context without changing defaults and does not inherit stale context", () => {
		const base: ApiConfiguration = { lmStudioMaxTokens: "4096" }
		assert.equal(buildApiHandlerForSelection(base, selected).getModel().info.contextWindow, 32768)
		const withoutMetadata = createApiConfigurationForModelProviderSelection(base, { provider: "lmstudio", modelId: "unknown" })
		assert.equal(Object.hasOwn(withoutMetadata, "lmStudioMaxTokens"), true)
		assert.equal(withoutMetadata.lmStudioMaxTokens, undefined)
		assert.deepEqual(base, { lmStudioMaxTokens: "4096" })
	})
})

describe("createApiConfigurationForModelProviderSelection", () => {
	it("preserves credentials while isolating selection and runtime settings from active mode state", () => {
		const base: ApiConfiguration = {
			actModeApiProvider: "anthropic",
			actModeApiModelId: "active-model",
			actModeReasoningEffort: "high",
			actModeThinkingBudgetTokens: 4096,
			geminiActModeThinkingLevel: "high",
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
			geminiActModeThinkingLevel: "high",
			apiKey: "credential",
			openRouterApiKey: "openrouter-credential",
			ulid: "active-task",
		})
		assert.equal(configuration.openRouterApiKey, "openrouter-credential")
		assert.equal(configuration.actModeApiProvider, "openrouter")
		assert.equal(configuration.actModeOpenRouterModelId, "openrouter/utility")
		assert.equal(configuration.actModeReasoningEffort, undefined)
		assert.equal(configuration.actModeThinkingBudgetTokens, undefined)
		assert.equal(configuration.geminiActModeThinkingLevel, undefined)
		assert.equal(configuration.disableRetries, false)
		assert.equal(configuration.ulid, "utility-invocation")
	})

	it("carries Utility reasoning without changing either main mode or runtime controls", () => {
		const base: ApiConfiguration = {
			planModeReasoningEffort: "high",
			planModeThinkingBudgetTokens: 8192,
			geminiPlanModeThinkingLevel: "high",
			actModeReasoningEffort: "high",
			actModeThinkingBudgetTokens: 4096,
			geminiActModeThinkingLevel: "high",
			geminiSearchEnabled: true,
			enableParallelToolCalling: true,
			disableRetries: true,
		}
		const original = structuredClone(base)
		for (const reasoningEffort of ["none", "high"] as const) {
			const configuration = createApiConfigurationForModelProviderSelection(base, {
				...selection("gemini", "gemini-model"),
				reasoningEffort,
				thinkingBudgetTokens: 0,
				geminiThinkingLevel: "low",
			})
			assert.equal(configuration.actModeReasoningEffort, reasoningEffort)
			assert.equal(configuration.actModeThinkingBudgetTokens, 0)
			assert.equal(configuration.geminiActModeThinkingLevel, "low")
			assert.equal(configuration.planModeReasoningEffort, "high")
			assert.equal(configuration.planModeThinkingBudgetTokens, 8192)
			assert.equal(configuration.geminiPlanModeThinkingLevel, "high")
			assert.equal(configuration.disableRetries, false)
			assert.equal(configuration.geminiSearchEnabled, false)
			assert.equal(configuration.enableParallelToolCalling, false)
		}
		assert.deepEqual(base, original)
	})

	it("enables provider retries even when the active runtime disabled them", () => {
		const base: ApiConfiguration = { disableRetries: true }
		const configuration = createApiConfigurationForModelProviderSelection(base, selection("openai-codex", "gpt-6-luna"))

		assert.equal(configuration.disableRetries, false)
		assert.equal(configuration.actModeApiModelId, "gpt-6-luna")
		assert.equal(base.disableRetries, true)
	})
})
