import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiConfiguration, ModelProviderSelection } from "@shared/api"
import { readModeSelection, saveApplicationModelSelection } from "./modelSelectionBinding"

const mocks = vi.hoisted(() => ({
	state: { getSystemDefaultSettingsKey: vi.fn(), getApiConfiguration: vi.fn(), setGlobalStateBatch: vi.fn(), flushPendingState: vi.fn() },
	transaction: vi.fn(async (_controller: unknown, _configuration: unknown, persist: () => Promise<void>) => persist()),
}))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => mocks.state } }))
vi.mock("@/core/controller/models/apiConfigurationTransaction", () => ({ applyApiConfigurationTransaction: mocks.transaction }))

describe("CLI model selection destinations", () => {
	it("retains legacy profile model and reasoning metadata without explicit mode fields", () => {
		const modelInfo = { supportsPromptCache: false, supportsReasoningEffort: true, reasoningEffortOptions: ["low", "high"] as const }
		const config: ApiConfiguration = { actModeApiProvider: "openai", actModeOpenAiProfileName: "Work", openAiCompatibleProfiles: [{ name: "Work", baseUrl: "http://localhost/v1", modelId: "custom", modelInfo: { ...modelInfo, reasoningEffortOptions: [...modelInfo.reasoningEffortOptions] } }] }
		expect(readModeSelection(config, "act")).toMatchObject({ modelId: "custom", modelInfo })
	})
	it("does not apply a profile model's metadata to a different explicit model", () => {
		const config: ApiConfiguration = { actModeApiProvider: "openai", actModeOpenAiProfileName: "Work", actModeOpenAiModelId: "model-b", openAiCompatibleProfiles: [{ name: "Work", baseUrl: "http://localhost/v1", modelId: "model-a", modelInfo: { supportsPromptCache: false, supportsReasoningEffort: true } }] }
		expect(readModeSelection(config, "act")).toMatchObject({ modelId: "model-b", modelInfo: undefined })
	})
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.state.getApiConfiguration.mockReturnValue({ actModeApiProvider: "anthropic", planModeApiProvider: "anthropic", actModeInferenceSpeed: "fast", planModeInferenceSpeed: "standard" })
		mocks.state.getSystemDefaultSettingsKey.mockReturnValue(undefined)
		mocks.state.flushPendingState.mockResolvedValue(undefined)
	})
	it("saves Utility without writing main provider/model fields", async () => {
		const selection: ModelProviderSelection = { provider: "openai", modelId: "custom", openAiProfileName: "Work", thinkingBudgetTokens: 0 }
		await saveApplicationModelSelection("utility", selection, false)
		expect(mocks.state.setGlobalStateBatch).toHaveBeenCalledWith({ utilityModelSelection: selection })
		expect(mocks.transaction).not.toHaveBeenCalled()
	})
	it("writes only addressed mode for separate configurations", async () => {
		await saveApplicationModelSelection("plan", { provider: "openrouter", modelId: "custom/new", reasoningEffort: "low" }, true)
		const patch = mocks.state.setGlobalStateBatch.mock.calls[0][0]
		expect(patch.planModeOpenRouterModelId).toBe("custom/new")
		expect(patch).not.toHaveProperty("actModeApiProvider")
	})
	it("does not reset compatible speed settings", async () => {
		await saveApplicationModelSelection("act", { provider: "anthropic", modelId: "claude-opus-4-8" }, false)
		const patch = mocks.state.setGlobalStateBatch.mock.calls[0][0]
		expect(patch.actModeInferenceSpeed).not.toBe("default")
		expect(patch.planModeInferenceSpeed).not.toBe("default")
	})
	it("retains custom Bedrock identity and explicit off", () => {
		const config: ApiConfiguration = { actModeApiProvider: "bedrock", actModeApiModelId: "arn:custom", actModeAwsBedrockCustomSelected: true, actModeAwsBedrockCustomModelBaseId: "base", actModeThinkingBudgetTokens: 0 }
		expect(readModeSelection(config, "act")).toMatchObject({ provider: "bedrock", modelId: "arn:custom", awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "base", thinkingBudgetTokens: 0 })
	})
	it("rejects picker sentinels before persistence", async () => {
		await expect(saveApplicationModelSelection("utility", { provider: "openai", modelId: "__custom__" }, false)).rejects.toThrow("Enter a model ID")
		expect(mocks.state.setGlobalStateBatch).not.toHaveBeenCalled()
	})
})
