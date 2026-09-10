import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	configureApiKeyProvider: vi.fn(),
	openUrlInBrowser: vi.fn(),
}))

vi.mock("../utils/provider-config.js", () => ({ configureApiKeyProvider: mocks.configureApiKeyProvider }))
vi.mock("../utils/browser.js", () => ({ openUrlInBrowser: mocks.openUrlInBrowser }))

import { AcpProviderSetup } from "./AcpProviderSetup.js"

describe("AcpProviderSetup", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.configureApiKeyProvider.mockResolvedValue(undefined)
		mocks.openUrlInBrowser.mockResolvedValue(undefined)
	})

	async function startSetup(): Promise<{
		setup: AcpProviderSetup
		authentication: Promise<void>
		setupUrl: URL
		nonce: string
	}> {
		const setup = new AcpProviderSetup()
		const authentication = setup.authenticate()
		await vi.waitFor(() => expect(mocks.openUrlInBrowser).toHaveBeenCalledOnce())
		const setupUrl = new URL(mocks.openUrlInBrowser.mock.calls[0][0])
		return { setup, authentication, setupUrl, nonce: setupUrl.pathname.split("/").at(-1)! }
	}

	it("persists browser-submitted provider configuration", async () => {
		const { authentication, setupUrl, nonce } = await startSetup()
		const response = await fetch(setupUrl, {
			method: "POST",
			body: new URLSearchParams({
				nonce,
				provider: "deepseek",
				apiKey: "secret-key",
				modelId: "deepseek-flash",
			}),
		})

		expect(response.status).toBe(200)
		await expect(authentication).resolves.toBeUndefined()
		expect(mocks.configureApiKeyProvider).toHaveBeenCalledWith({
			provider: "deepseek",
			apiKey: "secret-key",
			modelId: "deepseek-flash",
			baseUrl: undefined,
			azureApiVersion: undefined,
		})
	})

	it("keeps authentication open so invalid input can be corrected", async () => {
		mocks.configureApiKeyProvider.mockRejectedValueOnce(new Error("Invalid model ID"))
		const { authentication, setupUrl, nonce } = await startSetup()

		const failedResponse = await fetch(setupUrl, {
			method: "POST",
			body: new URLSearchParams({
				nonce,
				provider: "deepseek",
				apiKey: "secret-key",
				modelId: "invalid-model",
			}),
		})
		expect(failedResponse.status).toBe(400)
		const failurePage = await failedResponse.text()
		expect(failurePage).toContain("Invalid model ID")
		expect(failurePage).toContain('value="deepseek"')
		expect(failurePage).toContain('value="invalid-model"')

		const successfulResponse = await fetch(setupUrl, {
			method: "POST",
			body: new URLSearchParams({
				nonce,
				provider: "deepseek",
				apiKey: "secret-key",
				modelId: "deepseek-flash",
			}),
		})
		expect(successfulResponse.status).toBe(200)
		await expect(authentication).resolves.toBeUndefined()
		expect(mocks.configureApiKeyProvider).toHaveBeenCalledTimes(2)
	})
})
