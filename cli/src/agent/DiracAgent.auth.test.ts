import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	setRuntimeHooksDir: vi.fn(),
	startAuthorizationFlow: vi.fn(),
	waitForCallback: vi.fn(),
	cancelAuthorizationFlow: vi.fn(),
	clearCredentials: vi.fn(),
	openUrlInBrowser: vi.fn(),
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
		mocks.clearCredentials.mockResolvedValue(undefined)
	})

	it("completes the advertised OpenAI Codex OAuth authentication flow", async () => {
		const agent = new DiracAgent({})

		await expect(agent.authenticate({ methodId: "openai-codex-oauth" })).resolves.toEqual({})

		expect(mocks.startAuthorizationFlow).toHaveBeenCalledTimes(1)
		expect(mocks.openUrlInBrowser).toHaveBeenCalledWith("https://auth.openai.com/authorize")
		expect(mocks.waitForCallback).toHaveBeenCalledTimes(1)
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
})
