import type { ApiConfiguration } from "@shared/api"
import { describe, expect, it } from "vitest"
import { isSelectedProviderConfigured } from "./auth.js"

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
