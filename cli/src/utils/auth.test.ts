import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import type { ApiConfiguration } from "@shared/api"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isSelectedProviderConfigured } from "./auth.js"

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()), existsSync: vi.fn() }))
it("recognizes the default Qwen subscription cache without a custom path or API key", () => {
	vi.stubEnv("QWEN_HOME", "")
	vi.mocked(fs.existsSync).mockReturnValue(true)
	expect(isSelectedProviderConfigured({ actModeApiProvider: "qwen-code" }, "act")).toBe(true)
	expect(fs.existsSync).toHaveBeenLastCalledWith(path.join(os.homedir(), ".qwen", "subscription_credentials.json"))
})

it("uses QWEN_HOME, then lets a custom Qwen path override it", () => {
	vi.stubEnv("QWEN_HOME", "~/qwen-account")
	vi.mocked(fs.existsSync).mockReturnValue(true)
	const configuration: ApiConfiguration = { planModeApiProvider: "qwen-code" }
	expect(isSelectedProviderConfigured(configuration, "plan")).toBe(true)
	expect(fs.existsSync).toHaveBeenLastCalledWith(path.join(os.homedir(), "qwen-account", "subscription_credentials.json"))
	configuration.qwenCodeOauthPath = "~/custom/subscription_credentials.json"
	expect(isSelectedProviderConfigured(configuration, "plan")).toBe(true)
	expect(fs.existsSync).toHaveBeenLastCalledWith(path.join(os.homedir(), "custom", "subscription_credentials.json"))
})

it("does not accept a Qwen API key or a missing custom subscription file", () => {
	vi.mocked(fs.existsSync).mockReturnValue(false)
	const configuration: ApiConfiguration = { actModeApiProvider: "qwen-code", qwenApiKey: "direct-api-key" }
	expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
	configuration.qwenCodeOauthPath = "/missing/subscription_credentials.json"
	expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
})

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe("isSelectedProviderConfigured", () => {
	it("accepts a coherent DeepSeek configuration", () => {
		const configuration = {
			actModeApiProvider: "deepseek",
			actModeApiModelId: "deepseek-flash",
			deepSeekApiKey: "deepseek-key",
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(true)
	})

	it("does not accept a credential for a provider that is not selected", () => {
		const configuration = {
			actModeApiProvider: "openrouter",
			actModeOpenRouterModelId: "deepseek/deepseek-chat",
			deepSeekApiKey: "deepseek-key",
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
	})

	it("does not treat unrelated AWS credentials as OpenRouter authentication", () => {
		const configuration = {
			actModeApiProvider: "openrouter",
			actModeOpenRouterModelId: "deepseek/deepseek-chat",
			awsAccessKey: "AKIATEST",
			awsSecretKey: "secret",
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
	})

	it("requires OAuth credentials when OpenAI Codex is selected", () => {
		const configuration = {
			actModeApiProvider: "openai-codex",
			actModeApiModelId: "gpt-5-codex",
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
		configuration["openai-codex-oauth-credentials"] = "credentials"
		expect(isSelectedProviderConfigured(configuration, "act")).toBe(true)
	})

	it("accepts credentials stored in the selected OpenAI-compatible profile", () => {
		const configuration = {
			actModeApiProvider: "openai",
			actModeOpenAiProfileName: "local-profile",
			openAiCompatibleProfiles: [
				{
					name: "local-profile",
					apiKey: "profile-key",
					baseUrl: "https://openai-compatible.test/v1",
					modelId: "custom-model",
					modelInfo: {},
				},
			],
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(true)
	})

	it("does not accept an OpenAI-compatible base URL without credentials", () => {
		const configuration = {
			actModeApiProvider: "openai",
			openAiBaseUrl: "https://openai-compatible.test/v1",
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
	})

	it("does not accept a selected OpenAI-compatible profile without credentials", () => {
		const configuration = {
			actModeApiProvider: "openai",
			actModeOpenAiProfileName: "local-profile",
			openAiCompatibleProfiles: [
				{
					name: "local-profile",
					baseUrl: "https://openai-compatible.test/v1",
					modelId: "custom-model",
					modelInfo: {},
				},
			],
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
	})

	it("accepts the shared custom key with a selected OpenAI-compatible profile", () => {
		const configuration = {
			actModeApiProvider: "openai",
			actModeOpenAiProfileName: "local-profile",
			openAiCompatibleCustomApiKey: "custom-key",
			openAiCompatibleProfiles: [
				{
					name: "local-profile",
					baseUrl: "https://openai-compatible.test/v1",
					modelId: "custom-model",
					modelInfo: {},
				},
			],
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(true)
	})

	it("does not suppress authentication for a provider unsupported by the CLI", () => {
		const configuration = {
			actModeApiProvider: "oca",
			actModeApiModelId: "unsupported-model",
		} as ApiConfiguration

		expect(isSelectedProviderConfigured(configuration, "act")).toBe(false)
	})
})
