import assert from "node:assert/strict"
import { describe, it } from "mocha"
import type { ApiConfiguration } from "./api"
import { getConfiguredApiProviders } from "./configuredApiProviders"

const project = (apiConfiguration: ApiConfiguration) => getConfiguredApiProviders({ apiConfiguration })

describe("configured provider membership", () => {
	it("does not treat application defaults, model IDs or empty setup as configured providers", () => {
		assert.deepEqual(project({
			planModeApiProvider: "openrouter", actModeApiProvider: "openrouter",
			planModeOpenRouterModelId: "default-model", apiKey: " ", openAiBaseUrl: "",
			openAiHeaders: {}, openAiCompatibleProfiles: [], geminiSearchEnabled: true,
		}), [])
	})

	it("derives API key setups independently of active selection", () => {
		assert.deepEqual(project({
			planModeApiProvider: "anthropic", actModeApiProvider: "anthropic",
			apiKey: "anthropic-key", geminiApiKey: "gemini-key", openAiNativeApiKey: "openai-key",
		}), ["anthropic", "gemini", "openai-native"])
	})

	it("keeps expired OAuth credentials visible without parsing or validating tokens", () => {
		assert.deepEqual(project({
			"openai-codex-oauth-credentials": JSON.stringify({ access_token: "expired", expires_at: 1 }),
			"github-copilot-oauth-credentials": JSON.stringify({ access_token: "expired" }),
		}), ["openai-codex", "github-copilot"])
	})

	it("keeps keyless URLs and named profiles without requiring a model or API key", () => {
		assert.deepEqual(project({ openAiBaseUrl: "http://localhost:8080", lmStudioBaseUrl: "http://localhost:1234" }),
			["openai", "lmstudio"])
		assert.deepEqual(project({ openAiCompatibleProfiles: [{
			name: "Workstation", baseUrl: "http://localhost:8080", modelId: "",
			modelInfo: { supportsPromptCache: false },
		}] }), ["openai"])
	})

	it("recognizes AWS profiles, ADC setup and external authentication paths", () => {
		assert.deepEqual(project({
			awsProfile: "work", vertexProjectId: "project", claudeCodePath: "/usr/bin/claude",
			qwenCodeOauthPath: "/home/user/.qwen/oauth.json",
		}), ["claude-code", "bedrock", "vertex", "qwen-code"])
	})

	it("retains legacy selected keyless integrations with implicit/default setup", () => {
		assert.deepEqual(project({ planModeApiProvider: "claude-code", actModeApiProvider: "lmstudio" }),
			["claude-code", "lmstudio"])
		assert.deepEqual(project({ planModeApiProvider: "bedrock", actModeApiProvider: "qwen-code" }),
			["bedrock", "qwen-code"])
	})

	it("does not infer Qwen Code OAuth from an unrelated Qwen API key", () => {
		assert.deepEqual(project({ qwenApiKey: "key" }), ["qwen"])
	})

	it("unions explicit additions and redacted evidence in stable, duplicate-free provider order", () => {
		assert.deepEqual(getConfiguredApiProviders({
			apiConfiguration: { apiKey: "key" },
			addedApiProviders: ["vscode-lm", "lmstudio", "lmstudio"],
			configuredApiKeys: { anthropic: true, gemini: false },
			savedAuthProviders: ["openai-codex"],
		}), ["anthropic", "lmstudio", "openai-codex", "vscode-lm"])
	})

	it("does not mutate setup or explicit membership", () => {
		const apiConfiguration = Object.freeze({ openAiBaseUrl: "http://localhost:8080" })
		const addedApiProviders = Object.freeze(["vscode-lm"] as const)
		assert.deepEqual(getConfiguredApiProviders({ apiConfiguration, addedApiProviders }), ["openai", "vscode-lm"])
		assert.deepEqual(apiConfiguration, { openAiBaseUrl: "http://localhost:8080" })
		assert.deepEqual(addedApiProviders, ["vscode-lm"])
	})
})
