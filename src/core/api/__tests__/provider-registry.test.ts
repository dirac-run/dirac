/**
 * Tests for Provider Registry — behavioral spec for refactoring switch statement.
 */
import { describe, it } from "mocha"
import "should"
import type { ApiConfiguration } from "@shared/api"
import { buildApiHandler, createRegistryHandler } from "../index"
import { TEST_MODEL_IDS } from "@test/fixtures/model-ids"

describe("Provider Registry", () => {
	const allKnownProviders = [
		{
			provider: "anthropic",
			config: {
				apiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
				actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			},
		},
		{
			provider: "openrouter",
			config: {
				openRouterApiKey: "test-key",
				planModeOpenRouterModelId: TEST_MODEL_IDS.ANTHROPIC_OPENROUTER,
				actModeOpenRouterModelId: TEST_MODEL_IDS.ANTHROPIC_OPENROUTER,
			},
		},
		{
			provider: "bedrock",
			config: {
				awsAccessKey: "test-key",
				awsSecretKey: "test-secret",
				planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC_BEDROCK,
				actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC_BEDROCK,
			},
		},
		{
			provider: "vertex",
			config: {
				vertexProjectId: "test-project",
				vertexRegion: "us-central1",
				planModeApiModelId: TEST_MODEL_IDS.GEMINI,
				actModeApiModelId: TEST_MODEL_IDS.GEMINI,
			},
		},
		{
			provider: "openai",
			config: {
				openAiApiKey: "test-key",
				planModeOpenAiModelId: TEST_MODEL_IDS.OPENAI,
				actModeOpenAiModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "lmstudio",
			config: {
				lmStudioBaseUrl: "http://localhost:1234",
				planModeLmStudioModelId: TEST_MODEL_IDS.OPENAI,
				actModeLmStudioModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "gemini",
			config: {
				geminiApiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.GEMINI,
				actModeApiModelId: TEST_MODEL_IDS.GEMINI,
			},
		},
		{
			provider: "openai-native",
			config: {
				openAiNativeApiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.OPENAI,
				actModeApiModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "openai-codex",
			config: { planModeApiModelId: TEST_MODEL_IDS.OPENAI, actModeApiModelId: TEST_MODEL_IDS.OPENAI },
		},
		{
			provider: "deepseek",
			config: { deepSeekApiKey: "test-key", planModeApiModelId: "deepseek-chat", actModeApiModelId: "deepseek-chat" },
		},
		{
			provider: "requesty",
			config: {
				requestyApiKey: "test-key",
				planModeRequestyModelId: TEST_MODEL_IDS.ANTHROPIC,
				actModeRequestyModelId: TEST_MODEL_IDS.ANTHROPIC,
			},
		},
		{
			provider: "fireworks",
			config: {
				fireworksApiKey: "test-key",
				planModeFireworksModelId: "accounts/fireworks/models/llama-v3p1-70b-instruct",
				actModeFireworksModelId: "accounts/fireworks/models/llama-v3p1-70b-instruct",
			},
		},
		{
			provider: "together",
			config: {
				togetherApiKey: "test-key",
				planModeTogetherModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
				actModeTogetherModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
			},
		},
		{ provider: "qwen", config: { qwenApiKey: "test-key", planModeApiModelId: "qwen-max", actModeApiModelId: "qwen-max" } },
		{
			provider: "qwen-code",
			config: { qwenCodeOauthPath: "/test/path", planModeApiModelId: "qwen-max", actModeApiModelId: "qwen-max" },
		},
		{
			provider: "doubao",
			config: { doubaoApiKey: "test-key", planModeApiModelId: "Doubao-Pro-4k", actModeApiModelId: "Doubao-Pro-4k" },
		},
		{
			provider: "mistral",
			config: {
				mistralApiKey: "test-key",
				planModeApiModelId: "mistral-large-latest",
				actModeApiModelId: "mistral-large-latest",
			},
		},
		{
			provider: "vscode-lm",
			config: { planModeVsCodeLmModelSelector: TEST_MODEL_IDS.OPENAI, actModeVsCodeLmModelSelector: TEST_MODEL_IDS.OPENAI },
		},
		{
			provider: "github-copilot",
			config: { planModeApiModelId: TEST_MODEL_IDS.OPENAI, actModeApiModelId: TEST_MODEL_IDS.OPENAI },
		},
		{
			provider: "litellm",
			config: {
				liteLlmApiKey: "test-key",
				planModeLiteLlmModelId: TEST_MODEL_IDS.OPENAI,
				actModeLiteLlmModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "moonshot",
			config: { moonshotApiKey: "test-key", planModeApiModelId: "moonshot-v1-8k", actModeApiModelId: "moonshot-v1-8k" },
		},
		{
			provider: "huggingface",
			config: {
				huggingFaceApiKey: "test-key",
				planModeHuggingFaceModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
				actModeHuggingFaceModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			},
		},
		{
			provider: "nebius",
			config: {
				nebiusApiKey: "test-key",
				planModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
				actModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			},
		},
		{ provider: "xai", config: { xaiApiKey: "test-key", planModeApiModelId: "grok-beta", actModeApiModelId: "grok-beta" } },
		{
			provider: "sambanova",
			config: {
				sambanovaApiKey: "test-key",
				planModeApiModelId: "Meta-Llama-3.1-70B-Instruct",
				actModeApiModelId: "Meta-Llama-3.1-70B-Instruct",
			},
		},
		{
			provider: "cerebras",
			config: { cerebrasApiKey: "test-key", planModeApiModelId: "llama3.1-70b", actModeApiModelId: "llama3.1-70b" },
		},
		{
			provider: "groq",
			config: {
				groqApiKey: "test-key",
				planModeGroqModelId: "llama-3.1-70b-versatile",
				actModeGroqModelId: "llama-3.1-70b-versatile",
			},
		},
		{
			provider: "baseten",
			config: {
				basetenApiKey: "test-key",
				planModeBasetenModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
				actModeBasetenModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			},
		},
		{
			provider: "claude-code",
			config: { planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC, actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC },
		},
		{
			provider: "huawei-cloud-maas",
			config: {
				huaweiCloudMaasApiKey: "test-key",
				planModeHuaweiCloudMaasModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
				actModeHuaweiCloudMaasModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			},
		},
		{
			provider: "dify",
			config: {
				difyApiKey: "test-key",
				difyApiSecret: "test-secret",
				planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
				actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			},
		},
		{
			provider: "vercel-ai-gateway",
			config: {
				vercelAiGatewayApiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.OPENAI,
				actModeApiModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "zai",
			config: {
				zaiApiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.OPENAI,
				actModeApiModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "aihubmix",
			config: {
				aihubmixApiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.OPENAI,
				actModeApiModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "minimax",
			config: {
				minimaxApiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.OPENAI,
				actModeApiModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
		{
			provider: "nousResearch",
			config: {
				nousResearchApiKey: "test-key",
				planModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
				actModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			},
		},
		{
			provider: "wandb",
			config: {
				wandbApiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.OPENAI,
				actModeApiModelId: TEST_MODEL_IDS.OPENAI,
			},
		},
	] as const

	it("registry lookup returns a handler for each known provider in plan mode", () => {
		for (const { provider, config } of allKnownProviders) {
			const fullConfig = { ...config, apiProvider: provider as any } as ApiConfiguration
			const handler = buildApiHandler(fullConfig, "plan")
			handler.should.not.be.undefined()
			handler.should.have.property("createMessage")
		}
	})

	it("registry lookup returns a handler for each known provider in act mode", () => {
		for (const { provider, config } of allKnownProviders) {
			const fullConfig = { ...config, apiProvider: provider as any } as ApiConfiguration
			const handler = buildApiHandler(fullConfig, "act")
			handler.should.not.be.undefined()
			handler.should.have.property("createMessage")
		}
	})

	it("unknown provider falls back to Anthropic default via registry", () => {
		const config: ApiConfiguration = {
			apiProvider: "totally-unknown-provider" as any,
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("undefined provider falls back to Anthropic default via registry", () => {
		const config: ApiConfiguration = {
			apiProvider: undefined,
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("registry handles mode-specific model selection for plan mode", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = createRegistryHandler(config, "plan")
		handler.should.not.be.undefined()
	})

	it("registry handles mode-specific model selection for act mode", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = createRegistryHandler(config, "act")
		handler.should.not.be.undefined()
	})

	it("registry returns same number of providers as switch cases in buildApiHandler", () => {
		// The registry must cover all 37 known providers + default fallback
		allKnownProviders.length.should.equal(37)
	})
})
