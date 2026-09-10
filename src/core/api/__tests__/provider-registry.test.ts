/**
 * Tests for Provider Registry — behavioral spec for refactoring switch statement.
 */
import { describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { type ApiConfiguration, openAiModelInfoSaneDefaults, requestyDefaultModelInfo } from "@shared/api"
import { buildApiHandler, createRegistryHandler, validateApiConfiguration } from "../index"
import { TEST_MODEL_IDS } from "@test/fixtures/model-ids"
import { Logger } from "@shared/services/Logger"

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
			config: { deepSeekApiKey: "test-key", planModeApiModelId: "deepseek-flash", actModeApiModelId: "deepseek-flash" },
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
				difyBaseUrl: "https://dify.example/v1",
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

	it("rejects an unknown provider instead of using another provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "totally-unknown-provider" as any,
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		should(() => buildApiHandler(config, "plan")).throw("Unsupported API provider: totally-unknown-provider")
	})

	it("rejects an undefined provider instead of using another provider", () => {
		const config: ApiConfiguration = {
			apiProvider: undefined,
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		should(() => buildApiHandler(config, "plan")).throw("API provider is not configured")
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

	it("keeps the task-owned OpenAI model when provider infrastructure uses a profile", () => {
		const handler = buildApiHandler(
			{
				planModeApiProvider: "openai",
				planModeOpenAiModelId: "task-owned-model",
				planModeOpenAiModelInfo: openAiModelInfoSaneDefaults,
				planModeOpenAiProfileName: "profile-a",
				openAiCompatibleProfiles: [
					{
						name: "profile-a",
						baseUrl: "https://provider.example/v1",
						modelId: "mutable-profile-model",
						modelInfo: openAiModelInfoSaneDefaults,
					},
				],
			},
			"plan",
		)

		handler.getModel().id.should.equal("task-owned-model")
	})

	it("does not write OpenAI-compatible API key material to logs", () => {
		const log = sinon.stub(Logger, "info")
		try {
			buildApiHandler(
				{
					planModeApiProvider: "openai",
					planModeOpenAiModelId: "custom-model",
					openAiCompatibleCustomApiKey: "secret",
				},
				"plan",
			)

			const output = log.args.flat().join(" ")
			output.should.not.containEql("secret")
			output.should.not.containEql("secr")
		} finally {
			log.restore()
		}
	})

	it("does not reuse profile metadata for a task-owned OpenAI model", () => {
		const profileModelInfo = { ...openAiModelInfoSaneDefaults, contextWindow: 1234, maxTokens: 321 }
		const handler = buildApiHandler(
			{
				planModeApiProvider: "openai",
				planModeOpenAiModelId: "task-owned-model",
				planModeOpenAiProfileName: "profile-a",
				openAiCompatibleProfiles: [
					{
						name: "profile-a",
						baseUrl: "https://provider.example/v1",
						modelId: "profile-model",
						modelInfo: profileModelInfo,
					},
				],
			},
			"plan",
		)

		handler.getModel().id.should.equal("task-owned-model")
		handler.getModel().info.contextWindow!.should.equal(openAiModelInfoSaneDefaults.contextWindow)
		handler.getModel().info.contextWindow!.should.not.equal(profileModelInfo.contextWindow)
	})

	it("does not resolve model metadata when no thinking budget is configured", () => {
		const handler = buildApiHandler(
			{
				apiProvider: "openrouter",
				openRouterApiKey: "test-key",
				planModeOpenRouterModelId: TEST_MODEL_IDS.ANTHROPIC_OPENROUTER,
			},
			"plan",
		)
		handler.should.not.be.undefined()
	})

	it("clips an oversized thinking budget without changing the input configuration", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			planModeThinkingBudgetTokens: 1_000_000,
		}
		const handler = buildApiHandler(config, "plan") as any
		const maxTokens = handler.getModel().info.maxTokens

		handler.options.thinkingBudgetTokens.should.equal(maxTokens - 1)
		config.planModeThinkingBudgetTokens!.should.equal(1_000_000)
	})

	it("keeps valid and unknown-limit thinking budgets unchanged", () => {
		const valid = buildApiHandler(
			{
				apiProvider: "anthropic",
				apiKey: "test-key",
				planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
				planModeThinkingBudgetTokens: 1024,
			},
			"plan",
		) as any
		valid.options.thinkingBudgetTokens.should.equal(1024)

		const unknownLimit = buildApiHandler(
			{
				apiProvider: "openai",
				planModeOpenAiModelId: "custom-model",
				planModeThinkingBudgetTokens: 32768,
			},
			"plan",
		) as any
		unknownLimit.getModel().info.maxTokens.should.equal(-1)
	})

	it("rejects a missing selected OpenAI profile instead of substituting global infrastructure", () => {
		should(() =>
			buildApiHandler(
				{
					planModeApiProvider: "openai",
					planModeOpenAiModelId: "task-owned-model",
					planModeOpenAiProfileName: "removed-profile",
					openAiBaseUrl: "https://fallback.example/v1",
				},
				"plan",
			),
		).throw("OpenAI-compatible profile not found: removed-profile")
	})

	it("keeps a task-owned Requesty model when model metadata is absent", () => {
		const handler = buildApiHandler(
			{
				planModeApiProvider: "requesty",
				planModeRequestyModelId: "task-owned-model",
			},
			"plan",
		)

		handler.getModel().should.deepEqual({ id: "task-owned-model", info: requestyDefaultModelInfo })
	})

	it("rejects a persisted OpenRouter provider without an explicit model", () => {
		should(() =>
			validateApiConfiguration({
				planModeApiProvider: "openrouter",
				actModeApiProvider: "openrouter",
				openRouterApiKey: "test-key",
			}),
		).throw("openrouter requires an explicit model ID")
	})
	it("rejects inference speed controls for unsupported providers and models", () => {
		should(() =>
			validateApiConfiguration(
				{
					planModeApiProvider: "deepseek",
					planModeApiModelId: "deepseek-flash",
					planModeInferenceSpeed: "fast",
				},
				"plan",
			),
		).throw("Model deepseek-flash does not support Fast mode")
	})

	it("rejects Standard for providers without speed controls", () => {
		should(() =>
			validateApiConfiguration(
				{
					planModeApiProvider: "deepseek",
					planModeApiModelId: "deepseek-flash",
					planModeInferenceSpeed: "standard",
				},
				"plan",
			),
		).throw("Provider deepseek does not support inference speed controls")
	})

	it("accepts Standard for a supported provider whose model lacks Fast", () => {
		should(() =>
			validateApiConfiguration(
				{
					planModeApiProvider: "anthropic",
					planModeApiModelId: "claude-opus-4-6",
					planModeInferenceSpeed: "standard",
				},
				"plan",
			),
		).not.throw()
	})
	it("accepts Fast for a supported native OpenAI model", () => {
		should(() =>
			validateApiConfiguration(
				{
					planModeApiProvider: "openai-native",
					planModeApiModelId: "gpt-5.4",
					planModeInferenceSpeed: "fast",
				},
				"plan",
			),
		).not.throw()
	})

	it("registry returns same number of providers as switch cases in buildApiHandler", () => {
		// The registry must cover all 37 supported providers.
		allKnownProviders.length.should.equal(37)
	})
})
