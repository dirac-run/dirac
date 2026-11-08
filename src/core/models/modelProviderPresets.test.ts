import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { Controller } from "@core/controller"
import * as persistence from "@core/controller/models/apiConfigurationPersistence"
import * as transaction from "@core/controller/models/apiConfigurationTransaction"
import type { ApiConfiguration, ModelProviderPreset } from "@shared/api"
import { activateModelProviderPreset, recordSavedOpenAiCompatibleProfileChanges } from "./modelProviderPresets"

describe("recent model/provider preset reasoning ownership", () => {
	afterEach(() => sinon.restore())

	for (const mode of ["plan", "act"] as const) {
		for (const separateModels of [false, true]) {
			it(`preserves reasoning when activating from ${mode} with separate models ${separateModels}`, async () => {
				const preset: ModelProviderPreset = {
					id: "recent-preset",
					provider: "anthropic",
					modelId: "claude-model",
					lastUsedAt: 1,
				}
				const configuration: ApiConfiguration = {
					planModeApiModelId: "previous-plan-model",
					actModeApiModelId: "previous-act-model",
					planModeReasoningEffort: "none",
					planModeThinkingBudgetTokens: 0,
					geminiPlanModeThinkingLevel: "low",
					actModeReasoningEffort: "high",
					actModeThinkingBudgetTokens: 8192,
					geminiActModeThinkingLevel: "high",
				}
				const original = structuredClone(configuration)
				const controller = {
					stateManager: {
						getGlobalSettingsKey(key: string) {
							if (key === "modelProviderPresets") return [preset]
							if (key === "mode") return mode
							if (key === "planActSeparateModelsSetting") return separateModels
							throw new Error(`Unexpected setting: ${key}`)
						},
						getApiConfiguration: () => configuration,
						setGlobalState: sinon.stub(),
					},
					postStateToWebview: sinon.stub().resolves(),
				} as unknown as Controller
				const persist = sinon.stub(persistence, "persistApiConfigurationPatch")
				const apply = sinon.stub(transaction, "applyApiConfigurationTransaction").callsFake(async (_controller, _candidate, save) => {
					await save!()
				})

				await activateModelProviderPreset(controller, preset.id)

				const candidate = apply.firstCall.args[1]
				const patch = persist.firstCall.args[1]
				for (const key of [
					"planModeReasoningEffort",
					"planModeThinkingBudgetTokens",
					"geminiPlanModeThinkingLevel",
					"actModeReasoningEffort",
					"actModeThinkingBudgetTokens",
					"geminiActModeThinkingLevel",
				] as const) {
					assert.equal(candidate[key], original[key])
					assert.equal(Object.hasOwn(patch, key), false)
				}
				assert.equal(candidate.planModeApiModelId, !separateModels || mode === "plan" ? preset.modelId : original.planModeApiModelId)
				assert.equal(candidate.actModeApiModelId, !separateModels || mode === "act" ? preset.modelId : original.actModeApiModelId)
				assert.deepEqual(configuration, original)
			})
		}
	}
})

describe("endpoint profile preset reconciliation", () => {
	it("retains multiple model selections on an endpoint-only profile and removes deleted endpoints", () => {
		const presets = [
			{ id: "first", provider: "openai", modelId: "model-one", openAiProfileName: "Local", lastUsedAt: 1 },
			{ id: "second", provider: "openai", modelId: "model-two", openAiProfileName: "Local", lastUsedAt: 2 },
			{ id: "removed", provider: "openai", modelId: "model-three", openAiProfileName: "Deleted", lastUsedAt: 3 },
		]
		const setGlobalState = sinon.stub()
		const stateManager = {
			getApiConfiguration: () => ({ openAiCompatibleProfiles: [{ name: "Local", baseUrl: "http://localhost:1234", modelId: "" }] }),
			getGlobalSettingsKey: () => presets,
			setGlobalState,
		}
		recordSavedOpenAiCompatibleProfileChanges(stateManager as any, [])
		sinon.assert.calledOnceWithExactly(setGlobalState, "modelProviderPresets", presets.slice(0, 2))
	})
})
