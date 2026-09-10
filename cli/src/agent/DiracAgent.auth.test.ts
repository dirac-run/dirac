import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	setRuntimeHooksDir: vi.fn(),
	applyProviderConfig: vi.fn(),
	getSystemDefaultSettingsKey: vi.fn((key: string) => {
		if (key === "mode") return "act"
		if (key === "actModeApiProvider" || key === "planModeApiProvider") return "openrouter"
		return undefined
	}),
	startAuthorizationFlow: vi.fn(),
	waitForCallback: vi.fn(),
	cancelAuthorizationFlow: vi.fn(),
	clearCredentials: vi.fn(),
	openUrlInBrowser: vi.fn(),
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: vi.fn(() => ({
			getSystemDefaultSettingsKey: mocks.getSystemDefaultSettingsKey,
		})),
	},
}))

vi.mock("@/core/storage/disk", () => ({
	setRuntimeHooksDir: mocks.setRuntimeHooksDir,
}))

vi.mock("@/integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: {
		startAuthorizationFlow: mocks.startAuthorizationFlow,
		waitForCallback: mocks.waitForCallback,
		cancelAuthorizationFlow: mocks.cancelAuthorizationFlow,
		clearCredentials: mocks.clearCredentials,
	},
}))

vi.mock("../utils/provider-config.js", () => ({
	applyProviderConfig: mocks.applyProviderConfig,
}))

vi.mock("../utils/browser.js", () => ({
	openUrlInBrowser: mocks.openUrlInBrowser,
}))

import { DiracAgent } from "./DiracAgent.js"

describe("DiracAgent ACP authentication", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.startAuthorizationFlow.mockReturnValue("https://auth.openai.com/authorize")
		mocks.waitForCallback.mockResolvedValue({})
		mocks.openUrlInBrowser.mockResolvedValue(undefined)
		mocks.applyProviderConfig.mockResolvedValue(undefined)
		mocks.clearCredentials.mockResolvedValue(undefined)
	})

	it("completes the advertised OpenAI Codex OAuth authentication flow", async () => {
		const agent = new DiracAgent({})

		await expect(agent.authenticate({ methodId: "openai-codex-oauth" })).resolves.toEqual({})

		expect(mocks.startAuthorizationFlow).toHaveBeenCalledTimes(1)
		expect(mocks.openUrlInBrowser).toHaveBeenCalledWith("https://auth.openai.com/authorize")
		expect(mocks.waitForCallback).toHaveBeenCalledTimes(1)
		expect(mocks.applyProviderConfig).toHaveBeenCalledWith({ providerId: "openai-codex" })
	})

	it("rejects authentication methods it did not advertise", async () => {
		const agent = new DiracAgent({})

		await expect(agent.authenticate({ methodId: "unsupported" })).rejects.toThrow(
			"Unsupported authentication method: unsupported",
		)
		expect(mocks.startAuthorizationFlow).not.toHaveBeenCalled()
	})

	it("cancels any active OAuth flow and clears persisted credentials on logout", async () => {
		const agent = new DiracAgent({})

		await expect(agent.logout()).resolves.toBeUndefined()

		expect(mocks.cancelAuthorizationFlow).toHaveBeenCalledTimes(1)
		expect(mocks.clearCredentials).toHaveBeenCalledTimes(1)
	})

	it("uses explicit DIRAC_* settings instead of the synthetic OpenRouter default", () => {
		const previous = {
			provider: process.env.DIRAC_PROVIDER,
			model: process.env.DIRAC_MODEL,
			apiKey: process.env.DIRAC_API_KEY,
		}
		process.env.DIRAC_PROVIDER = "deepseek"
		process.env.DIRAC_MODEL = "deepseek-flash"
		process.env.DIRAC_API_KEY = "deepseek-key"

		try {
			const overrides = (new DiracAgent({}) as any).createStartupSessionOverrides()
			expect(overrides.actModeApiProvider).toBe("deepseek")
			expect(overrides.planModeApiProvider).toBe("deepseek")
			expect(overrides.actModeApiModelId).toBe("deepseek-flash")
			expect(overrides.planModeApiModelId).toBe("deepseek-flash")
		} finally {
			if (previous.provider === undefined) delete process.env.DIRAC_PROVIDER
			else process.env.DIRAC_PROVIDER = previous.provider
			if (previous.model === undefined) delete process.env.DIRAC_MODEL
			else process.env.DIRAC_MODEL = previous.model
			if (previous.apiKey === undefined) delete process.env.DIRAC_API_KEY
			else process.env.DIRAC_API_KEY = previous.apiKey
		}
	})
})
