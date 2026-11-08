import { beforeEach, describe, expect, it, vi } from "vitest"

const stateManager = {
	getGlobalSettingsKey: vi.fn(),
	getSystemDefaultSettingsKey: vi.fn(),
	setGlobalState: vi.fn(),
	getApiConfiguration: vi.fn(),
	getSecretKey: vi.fn(),
	setApiConfiguration: vi.fn(),
	flushPendingState: vi.fn(),
}

const applyApiConfigurationTransaction = vi.fn(
	async (
		controller: any,
		_configuration: Record<string, unknown>,
		persist: () => void | Promise<void>,
		_mode?: unknown,
		activePatch?: Record<string, unknown>,
	) => {
		if (controller.task) {
			await controller.task.applyWorkingConfigurationUpdate(
				{ apiConfiguration: activePatch },
				persist,
			)
		} else {
			await persist()
		}
	},
)

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: vi.fn(() => stateManager) },
}))

vi.mock("@shared/storage", () => ({
	getProviderModelIdKey: (provider: string, mode: "act" | "plan") =>
		provider === "bedrock"
			? mode === "act"
				? "actModeAwsBedrockModelId"
				: "planModeAwsBedrockModelId"
			: mode === "act"
				? "actModeOpenRouterModelId"
				: "planModeOpenRouterModelId",
	isSecretKey: (key: string) => ["openRouterApiKey", "openAiApiKey", "awsAccessKey", "awsSecretKey", "awsSessionToken", "openai-codex-oauth-credentials", "github-copilot-oauth-credentials"].includes(key),
	ProviderToApiKeyMap: { openrouter: "openRouterApiKey", openai: "openAiApiKey" },
	ProviderToBaseUrlKeyMap: { openai: "openAiBaseUrl" },
}))

vi.mock("@/core/controller/models/apiConfigurationTransaction", () => ({
	applyApiConfigurationTransaction,
	applyProviderSetupTransaction: vi.fn(async (_context: unknown, _patch: unknown, persist: () => Promise<void>) => persist()),
}))

vi.mock("@/core/controller/models/refreshOpenRouterModels", () => ({
	refreshOpenRouterModels: vi.fn(),
}))

vi.mock("@/core/controller/models/refreshVercelAiGatewayModels", () => ({
	refreshVercelAiGatewayModels: vi.fn(),
}))

vi.mock("./model-metadata", () => ({
	getDefaultModelId: vi.fn(() => ""),
	getModelList: vi.fn(() => []),
}))

const { applyBedrockConfig, applyProviderConfig, saveProviderSetup, saveBedrockSetup } = await import("./provider-config")

function createController(task?: any) {
	return {
		task,
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
	} as any
}

describe("provider configuration transactions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		stateManager.getGlobalSettingsKey.mockReturnValue(undefined)
		stateManager.getSystemDefaultSettingsKey.mockImplementation((key: string) =>
			key === "addedApiProviders" ? [] : key.endsWith("ApiProvider") ? "anthropic" : undefined,
		)
		stateManager.getApiConfiguration.mockReturnValue({
			actModeApiProvider: "anthropic",
			planModeApiProvider: "anthropic",
			openRouterApiKey: "redacted-from-settings-view",
		})
		stateManager.getSecretKey.mockImplementation((key: string) =>
			key === "openRouterApiKey" ? "old-secret" : undefined,
		)
		stateManager.flushPendingState.mockResolvedValue(undefined)
	})

	it("records explicit keyless addition and restores membership on failed persistence", async () => {
		await saveProviderSetup({ providerId: "lmstudio" })
		expect(stateManager.setApiConfiguration).toHaveBeenCalledWith({})
		expect(stateManager.setGlobalState).toHaveBeenCalledWith("addedApiProviders", ["lmstudio"])
		stateManager.flushPendingState.mockRejectedValueOnce(new Error("flush failed"))
		await expect(saveProviderSetup({ providerId: "lmstudio" })).rejects.toThrow("flush failed")
		expect(stateManager.setGlobalState).toHaveBeenLastCalledWith("addedApiProviders", [])
	})

	it("projects only the newly authenticated OAuth credential into setup", async () => {
		stateManager.getSecretKey.mockReturnValue("fresh-credential")
		await saveProviderSetup({ providerId: "openai-codex", controller: createController() })
		expect(stateManager.setApiConfiguration).toHaveBeenCalledWith({ "openai-codex-oauth-credentials": "fresh-credential" })
		expect(applyApiConfigurationTransaction).not.toHaveBeenCalled()
	})

	it("accepts onboarding's empty optional base URL for providers without endpoint setup", async () => {
		await applyProviderConfig({ providerId: "openrouter", apiKey: "new-secret", modelId: "model", baseUrl: "" })
		expect(stateManager.setApiConfiguration.mock.calls[0][0]).not.toHaveProperty("openAiBaseUrl")
	})

	it("saves OpenRouter access before any application model exists", async () => {
		stateManager.getApiConfiguration.mockReturnValue({})
		await saveProviderSetup({ providerId: "openrouter", apiKey: "new-secret", controller: createController() })
		expect(stateManager.setApiConfiguration).toHaveBeenCalledWith({ openRouterApiKey: "new-secret" })
		expect(applyApiConfigurationTransaction).not.toHaveBeenCalled()
	})

	it("saves keyless setup without provider/model writes", async () => {
		await saveProviderSetup({ providerId: "openai", apiKey: "", baseUrl: "http://localhost:1234/v1/chat/completions/" })
		expect(stateManager.setApiConfiguration).toHaveBeenCalledWith({ openAiApiKey: "", openAiBaseUrl: "http://localhost:1234/v1" })
		expect(applyApiConfigurationTransaction).not.toHaveBeenCalled()
	})

	it.each<Record<string, string>>([{ "X-Proxy": "new-value" }, {}])("saves legacy headers with endpoint access in one setup patch: %j", async (headers) => {
		await saveProviderSetup({ providerId: "openai", apiKey: "new-key", baseUrl: "http://proxy/v1/", headers })
		expect(stateManager.setApiConfiguration).toHaveBeenCalledExactlyOnceWith({ openAiApiKey: "new-key", openAiBaseUrl: "http://proxy/v1", openAiHeaders: headers })
		expect(applyApiConfigurationTransaction).not.toHaveBeenCalled()
	})

	it("rolls back headers together with legacy credentials and URL on persistence failure", async () => {
		const previous = { openAiApiKey: "old-key", openAiBaseUrl: "http://old/v1", openAiHeaders: { "X-Proxy": "old" } }
		stateManager.getSecretKey.mockReturnValue(previous.openAiApiKey)
		stateManager.getSystemDefaultSettingsKey.mockImplementation((key: string) => key === "addedApiProviders" ? [] : previous[key as keyof typeof previous])
		stateManager.flushPendingState.mockRejectedValueOnce(new Error("flush failed"))
		await expect(saveProviderSetup({ providerId: "openai", apiKey: "new", baseUrl: "http://new", headers: {} })).rejects.toThrow("flush failed")
		expect(stateManager.setApiConfiguration).toHaveBeenLastCalledWith(previous)
	})

	it.each([" https://bedrock.internal/ ", ""])("persists a changed or cleared Bedrock endpoint without model writes: %j", async (endpoint) => {
		const setup = { awsAuthentication: "profile", awsProfile: "work", awsRegion: "us-east-1", awsUseCrossRegionInference: false, awsBedrockEndpoint: endpoint }
		await saveBedrockSetup({ bedrockConfig: setup })
		expect(stateManager.setApiConfiguration).toHaveBeenCalledExactlyOnceWith({ ...setup, awsBedrockEndpoint: endpoint.trim(), awsUseProfile: true })
		expect(applyApiConfigurationTransaction).not.toHaveBeenCalled()
	})

	it("saves Bedrock profile setup without custom-model flags or selection", async () => {
		await saveBedrockSetup({ bedrockConfig: { awsAuthentication: "profile", awsProfile: "work", awsRegion: "us-east-1", awsUseCrossRegionInference: false } })
		expect(stateManager.setApiConfiguration).toHaveBeenCalledWith({ awsAuthentication: "profile", awsUseProfile: true, awsProfile: "work", awsRegion: "us-east-1", awsUseCrossRegionInference: false })
	})

	it("restores persisted setup defaults rather than effective task overrides on failure", async () => {
		stateManager.getSystemDefaultSettingsKey.mockImplementation((key: string) => key === "openAiBaseUrl" ? "http://saved" : [])
		stateManager.getApiConfiguration.mockReturnValue({ openAiBaseUrl: "http://task-override" })
		stateManager.flushPendingState.mockRejectedValueOnce(new Error("flush failed"))
		await expect(saveProviderSetup({ providerId: "openai", baseUrl: "http://new" })).rejects.toThrow("flush failed")
		expect(stateManager.setApiConfiguration).toHaveBeenLastCalledWith({ openAiBaseUrl: "http://saved" })
	})

	it("rejects OpenRouter without an explicit or saved model", async () => {
		await expect(applyProviderConfig({ providerId: "openrouter" })).rejects.toThrow(
			"Select an OpenRouter model before configuring the provider",
		)
		expect(stateManager.setApiConfiguration).not.toHaveBeenCalled()
	})

	it("validates the active Task candidate before provider fields are written", async () => {
		const invalidCandidate = new Error("invalid candidate")
		const task = {
			applyWorkingConfigurationUpdate: vi.fn().mockRejectedValue(invalidCandidate),
		}
		const controller = createController(task)

		await expect(
			applyProviderConfig({ providerId: "openrouter", modelId: "model", apiKey: "new-secret", controller }),
		).rejects.toBe(invalidCandidate)

		expect(task.applyWorkingConfigurationUpdate).toHaveBeenCalledTimes(1)
		expect(stateManager.setApiConfiguration).not.toHaveBeenCalled()
		expect(stateManager.flushPendingState).not.toHaveBeenCalled()
		expect(controller.postStateToWebview).not.toHaveBeenCalled()
	})

	it("restores only explicitly addressed provider fields when durable flush fails", async () => {
		const flushError = new Error("flush failed")
		let taskRevision = 7
		stateManager.flushPendingState.mockRejectedValueOnce(flushError).mockResolvedValueOnce(undefined)
		const task = {
			applyWorkingConfigurationUpdate: vi.fn(async (_patch, beforeCommit) => {
				await beforeCommit()
				taskRevision += 1
			}),
		}
		const controller = createController(task)

		await expect(
			applyProviderConfig({ providerId: "openrouter", modelId: "model", apiKey: "new-secret", controller }),
		).rejects.toBe(flushError)

		expect(stateManager.setApiConfiguration).toHaveBeenCalledTimes(2)
		const written = stateManager.setApiConfiguration.mock.calls[0][0]
		const restored = stateManager.setApiConfiguration.mock.calls[1][0]
		expect(written).toMatchObject({
			actModeApiProvider: "openrouter",
			planModeApiProvider: "openrouter",
			openRouterApiKey: "new-secret",
		})
		expect(restored).toEqual(
			Object.fromEntries(
				Object.keys(written).map((key) => [key, key === "openRouterApiKey" ? "old-secret" : stateManager.getSystemDefaultSettingsKey(key)]),
			),
		)
		expect(restored).not.toHaveProperty("unrelatedSetting")
		expect(stateManager.flushPendingState).toHaveBeenCalledTimes(2)
		expect(taskRevision).toBe(7)
		expect(controller.postStateToWebview).not.toHaveBeenCalled()
	})

	it("commits and publishes provider configuration after a successful flush", async () => {
		const task = {
			applyWorkingConfigurationUpdate: vi.fn(async (_patch, beforeCommit) => {
				await beforeCommit()
			}),
		}
		const controller = createController(task)

		await applyProviderConfig({ providerId: "openrouter", modelId: "model", apiKey: "new-secret", controller })

		expect(task.applyWorkingConfigurationUpdate).toHaveBeenCalledTimes(1)
		expect(stateManager.setApiConfiguration).toHaveBeenCalledTimes(1)
		expect(stateManager.flushPendingState).toHaveBeenCalledTimes(1)
		expect(controller.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("uses the same rollback-safe persistence boundary for Bedrock", async () => {
		const flushError = new Error("bedrock flush failed")
		stateManager.flushPendingState.mockRejectedValueOnce(flushError).mockResolvedValueOnce(undefined)
		const task = {
			applyWorkingConfigurationUpdate: vi.fn(async (_patch, beforeCommit) => {
				await beforeCommit()
			}),
		}
		const controller = createController(task)

		await expect(
			applyBedrockConfig({
				bedrockConfig: {
					awsAuthentication: "credentials",
					awsRegion: "us-east-1",
					awsUseCrossRegionInference: false,
					awsAccessKey: "new-access",
					awsSecretKey: "new-secret",
				} as any,
				modelId: "bedrock-model",
				controller,
			}),
		).rejects.toBe(flushError)

		expect(stateManager.setApiConfiguration).toHaveBeenCalledTimes(2)
		expect(stateManager.flushPendingState).toHaveBeenCalledTimes(2)
		expect(controller.postStateToWebview).not.toHaveBeenCalled()
	})

	it("preserves the no-controller persistence and flush behavior", async () => {
		await applyProviderConfig({ providerId: "openrouter", modelId: "model", apiKey: "new-secret" })

		expect(applyApiConfigurationTransaction).not.toHaveBeenCalled()
		expect(stateManager.setApiConfiguration).toHaveBeenCalledTimes(1)
		expect(stateManager.flushPendingState).toHaveBeenCalledTimes(1)
	})
})
