import { strict as assert } from "node:assert"
import { anthropicDefaultModelId, anthropicModels, type ApiConfiguration } from "@shared/api"
import { setVscodeHostProviderMock } from "@test/host-provider-test-utils"
import { stringifyVsCodeLmModelSelector, type LanguageModelChatSelector } from "@shared/vsCodeSelectorUtils"
import type { LocalState, Settings } from "@shared/storage/state-keys"
import type { SubagentRole } from "@shared/subagentRoles"
import { describe, it } from "mocha"
import { buildTaskWorkingConfigurationUpdate, createTaskWorkingConfiguration } from "./runtime/TaskWorkingConfiguration"
import { resolveTaskletConfiguration, taskletWorkingConfiguration } from "./index"

function parentConfiguration(api: ApiConfiguration = {}, settings: Partial<Settings> = {}) {
	return createTaskWorkingConfiguration({
		settings: { mode: "plan", preferredLanguage: "French", ...settings } as Settings,
		apiConfiguration: {
			planModeApiProvider: "anthropic", planModeApiModelId: "claude-opus-4-6",
			actModeApiProvider: "anthropic", actModeApiModelId: "claude-opus-4-6",
			apiKey: "parent-secret", openRouterApiKey: "router-secret", ...api,
		},
		workspaceConfiguration: { localSkillsToggles: { fixture: true } } as unknown as LocalState,
		executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
	})
}

describe("durable tasklet model selection", () => {
	it("captures default active Plan settings including explicit off reasoning, then retains model with current credentials and authority", async () => {
		const parent = parentConfiguration({ planModeReasoningEffort: "none", planModeThinkingBudgetTokens: 0 })
		const resolved = await resolveTaskletConfiguration({ type: "default" }, parent)
		assert.equal(resolved.name, "default")
		assert.equal(resolved.modelSelection.modelId, "claude-opus-4-6")
		assert.equal(resolved.modelSelection.reasoningEffort, "none")
		assert.equal(resolved.modelSelection.thinkingBudgetTokens, 0)
		assert.doesNotMatch(JSON.stringify(resolved), /secret|apiKey|includeHistory|timeoutSeconds/)
		const changed = buildTaskWorkingConfigurationUpdate(parent, {
			settings: { strictPlanModeEnabled: true },
			apiConfiguration: { planModeApiModelId: "claude-sonnet-4-6", apiKey: "rotated-secret", planModeThinkingBudgetTokens: 4096 },
		})
		const child = taskletWorkingConfiguration(changed, resolved)
		assert.equal(child.settings.mode, "act")
		assert.equal(child.settings.strictPlanModeEnabled, true)
		assert.equal(child.apiConfiguration.actModeApiModelId, "claude-opus-4-6")
		assert.equal(child.apiConfiguration.actModeThinkingBudgetTokens, 0)
		assert.equal(child.apiConfiguration.apiKey, "rotated-secret")
		assert.equal(parent.settings.mode, "plan")
	})

	it("captures an installed default model even when the parent's configured ID is obsolete", async () => {
		const parent = parentConfiguration({ planModeApiModelId: "claude-opus-4-20250514" })
		const installed = { id: anthropicDefaultModelId, info: anthropicModels[anthropicDefaultModelId] }
		const captured = await resolveTaskletConfiguration({ type: "default" }, parent, [], installed)
		assert.equal(captured.modelSelection.modelId, installed.id)
		assert.equal(taskletWorkingConfiguration(parent, captured).apiConfiguration.actModeApiModelId, installed.id)
		await assert.rejects(resolveTaskletConfiguration({ type: "Reviewer" }, parent, [{
			name: "Reviewer", description: "Explicit model must remain strict", enabled: true,
			modelSelection: { provider: "anthropic", modelId: "claude-opus-4-20250514" },
		}]), /unavailable/)
	})

	it("captures provider-specific model and named endpoint rather than generic model field", async () => {
		const parent = parentConfiguration({
			planModeApiProvider: "openai", planModeApiModelId: "unrelated-generic",
			planModeOpenAiModelId: "local/custom", planModeOpenAiProfileName: "Local",
			openAiCompatibleProfiles: [{ name: "Local", baseUrl: "http://localhost:1234/v1", modelId: "legacy-model", modelInfo: { contextWindow: 8192, supportsPromptCache: false } }],
		})
		const resolved = await resolveTaskletConfiguration({ type: "default" }, parent)
		assert.equal(resolved.modelSelection.modelId, "local/custom")
		assert.equal(resolved.modelSelection.openAiProfileName, "Local")
		assert.equal(taskletWorkingConfiguration(parent, resolved).apiConfiguration.actModeOpenAiModelId, "local/custom")
	})

	it("captures the Huawei model-specific selection instead of a stale generic model", async () => {
		const modelInfo = { contextWindow: 32768, supportsPromptCache: false }
		const parent = parentConfiguration({
			planModeApiProvider: "huawei-cloud-maas", planModeApiModelId: "unrelated-generic",
			planModeHuaweiCloudMaasModelId: "custom-huawei-model", planModeHuaweiCloudMaasModelInfo: modelInfo,
			huaweiCloudMaasApiKey: "huawei-secret",
		})
		const resolved = await resolveTaskletConfiguration({ type: "default" }, parent)
		assert.equal(resolved.modelSelection.modelId, "custom-huawei-model")
		assert.deepEqual(resolved.modelSelection.modelInfo, modelInfo)
		assert.equal(taskletWorkingConfiguration(parent, resolved).apiConfiguration.actModeHuaweiCloudMaasModelId, "custom-huawei-model")
	})

	it("captures Dify's fixed workflow model but rejects an invalid explicit role ID", async () => {
		const parent = parentConfiguration({
			planModeApiProvider: "dify", planModeApiModelId: "unrelated-generic",
			difyApiKey: "dify-secret", difyBaseUrl: "https://dify.example/v1",
		})
		const resolved = await resolveTaskletConfiguration({ type: "default" }, parent)
		assert.equal(resolved.modelSelection.modelId, "dify-workflow")
		assert.equal(taskletWorkingConfiguration(parent, resolved).apiConfiguration.actModeApiModelId, "dify-workflow")
		await assert.rejects(resolveTaskletConfiguration({ type: "Broken" }, parent, [{
			name: "Broken", description: "Invalid workflow ID.", enabled: true,
			modelSelection: { provider: "dify", modelId: "unrelated-generic" },
		}]), /unavailable/)
	})

	it("captures the VS Code selector identity rather than a stale generic model", async () => {
		let created = 0
		let disposed = 0
		setVscodeHostProviderMock({
			capabilities: {
				createVsCodeLmHandler: (options) => {
					created++
					return {
						createMessage: () => { throw new Error("Unexpected API request") },
						dispose: () => { disposed++ },
						getModel: () => ({
							id: stringifyVsCodeLmModelSelector(options.vsCodeLmModelSelector as LanguageModelChatSelector),
							info: { contextWindow: 32768, supportsPromptCache: false },
						}),
					}
				},
			}
		})
		const selector = { vendor: "copilot", family: "gpt-4", id: "selected-model" }
		const parent = parentConfiguration({
			planModeApiProvider: "vscode-lm", planModeApiModelId: "unrelated-generic",
			planModeVsCodeLmModelSelector: selector,
		})
		const resolved = await resolveTaskletConfiguration({ type: "default" }, parent)
		assert.equal(resolved.modelSelection.modelId, stringifyVsCodeLmModelSelector(selector))
		assert.deepEqual(resolved.modelSelection.vsCodeLmModelSelector, selector)
		assert.deepEqual(taskletWorkingConfiguration(parent, resolved).apiConfiguration.actModeVsCodeLmModelSelector, selector)
		assert.equal(created, 3)
		assert.equal(disposed, created, "Every capture/validation probe must release its listener")
		const installed = { id: "resolved-vscode-client-id", info: { contextWindow: 65536, supportsPromptCache: false } }
		const captured = await resolveTaskletConfiguration({ type: "default" }, parent, [], installed)
		assert.equal(created, 4, "Installed parent metadata eliminates the capture probe; only selection validation remains")
		assert.equal(captured.modelSelection.modelId, stringifyVsCodeLmModelSelector(selector))
		assert.equal(captured.modelSelection.modelInfo?.contextWindow, 65536)
		assert.equal(disposed, created)
		await assert.rejects(resolveTaskletConfiguration({ type: "Broken" }, parent, [{
			name: "Broken", description: "Mismatched selector.", enabled: true,
			modelSelection: { provider: "vscode-lm", modelId: "unrelated-generic", vsCodeLmModelSelector: selector },
		}]), /unavailable/)
		assert.equal(disposed, created, "Rejected selections must release their validation handler too")
	})

	it("snapshots role settings without credentials and never rereads the preset on resume", async () => {
		const role: SubagentRole = {
			name: "Reviewer", description: "Review work.", enabled: true,
			modelSelection: { provider: "anthropic", modelId: "claude-sonnet-4-6", reasoningEffort: "high", thinkingBudgetTokens: 2048 }
		}
		const parent = parentConfiguration()
		const resolved = await resolveTaskletConfiguration({ type: "Reviewer" }, parent, [role])
		role.modelSelection!.modelId = "claude-opus-4-6"
		role.enabled = false
		assert.equal(resolved.modelSelection.modelId, "claude-sonnet-4-6")
		const reopened = JSON.parse(JSON.stringify(resolved))
		assert.equal(taskletWorkingConfiguration(parent, reopened).apiConfiguration.actModeApiModelId, "claude-sonnet-4-6")
		await assert.rejects(resolveTaskletConfiguration({ type: "Reviewer" }, parent, [role]), /Unavailable/)
		await assert.rejects(resolveTaskletConfiguration({ type: "Reviewer" }, parent, []), /Unavailable/)
	})

	it("rejects credentialful or obsolete saved configuration at resumption", () => {
		const selection = { provider: "anthropic", modelId: "claude-opus-4-6" }
		for (const configuration of [
			{ name: "default", modelSelection: { ...selection, apiKey: "frozen-secret" } },
			{ name: "default", modelSelection: selection, timeoutSeconds: 600 },
		]) {
			assert.throws(() => taskletWorkingConfiguration(parentConfiguration(), configuration as never), /Unsupported saved/)
		}
	})

	it("rejects missing saved selection instead of following the parent on resume", () => {
		assert.throws(() => taskletWorkingConfiguration(parentConfiguration(), undefined), /no saved model selection/)
	})

	it("reports unavailable role models rather than silently substituting the provider default", async () => {
		await assert.rejects(resolveTaskletConfiguration({ type: "Broken" }, parentConfiguration(), [{
			name: "Broken", description: "Invalid model.", enabled: true,
			modelSelection: { provider: "anthropic", modelId: "missing-model" },
		}]), /unavailable/)
	})
})
