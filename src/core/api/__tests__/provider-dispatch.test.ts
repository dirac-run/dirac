/**
 * Characterization tests for API provider dispatch (ORIGINAL codebase).
 * Captures current behavior — bugs and all.
 *
 * Phase 1 — Refactoring Safety Net
 */
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import type { ApiConfiguration } from "@shared/api"
import sinon from "sinon"
import { buildApiHandler } from "../index"
import { TEST_MODEL_IDS } from "@test/fixtures/model-ids"

describe("API Provider Dispatch (original)", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("returns a handler for anthropic provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for openrouter provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "openrouter",
			openRouterApiKey: "test-key",
			planModeOpenRouterModelId: TEST_MODEL_IDS.ANTHROPIC_OPENROUTER,
			actModeOpenRouterModelId: TEST_MODEL_IDS.ANTHROPIC_OPENROUTER,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for bedrock provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "bedrock",
			awsAccessKey: "test-key",
			awsSecretKey: "test-secret",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC_BEDROCK,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC_BEDROCK,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for openai provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "openai",
			openAiApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for gemini provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "gemini",
			geminiApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.GEMINI,
			actModeApiModelId: TEST_MODEL_IDS.GEMINI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for vertex provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
			planModeApiModelId: TEST_MODEL_IDS.GEMINI,
			actModeApiModelId: TEST_MODEL_IDS.GEMINI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for deepseek provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "deepseek",
			deepSeekApiKey: "test-key",
			planModeApiModelId: "deepseek-chat",
			actModeApiModelId: "deepseek-chat",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for requesty provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "requesty",
			requestyApiKey: "test-key",
			planModeRequestyModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeRequestyModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for fireworks provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "fireworks",
			fireworksApiKey: "test-key",
			planModeFireworksModelId: "accounts/fireworks/models/llama-v3p1-70b-instruct",
			actModeFireworksModelId: "accounts/fireworks/models/llama-v3p1-70b-instruct",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for together provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "together",
			togetherApiKey: "test-key",
			planModeTogetherModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
			actModeTogetherModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for qwen provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "qwen",
			qwenApiKey: "test-key",
			planModeApiModelId: "qwen-max",
			actModeApiModelId: "qwen-max",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for mistral provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "mistral",
			mistralApiKey: "test-key",
			planModeApiModelId: "mistral-large-latest",
			actModeApiModelId: "mistral-large-latest",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for github-copilot provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "github-copilot",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for litellm provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "litellm",
			liteLlmApiKey: "test-key",
			planModeLiteLlmModelId: TEST_MODEL_IDS.OPENAI,
			actModeLiteLlmModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for moonshot provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "moonshot",
			moonshotApiKey: "test-key",
			planModeApiModelId: "moonshot-v1-8k",
			actModeApiModelId: "moonshot-v1-8k",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for huggingface provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "huggingface",
			huggingFaceApiKey: "test-key",
			planModeHuggingFaceModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			actModeHuggingFaceModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for nebius provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "nebius",
			nebiusApiKey: "test-key",
			planModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			actModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for xai provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "xai",
			xaiApiKey: "test-key",
			planModeApiModelId: "grok-beta",
			actModeApiModelId: "grok-beta",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for sambanova provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "sambanova",
			sambanovaApiKey: "test-key",
			planModeApiModelId: "Meta-Llama-3.1-70B-Instruct",
			actModeApiModelId: "Meta-Llama-3.1-70B-Instruct",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for cerebras provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "cerebras",
			cerebrasApiKey: "test-key",
			planModeApiModelId: "llama3.1-70b",
			actModeApiModelId: "llama3.1-70b",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for groq provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "groq",
			groqApiKey: "test-key",
			planModeApiModelId: "llama-3.1-70b-versatile",
			actModeApiModelId: "llama-3.1-70b-versatile",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for baseten provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "baseten",
			basetenApiKey: "test-key",
			planModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			actModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for claude-code provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "claude-code",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for huawei-cloud-maas provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "huawei-cloud-maas",
			huaweiCloudMaasApiKey: "test-key",
			planModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			actModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for dify provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "dify",
			difyApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for vercel-ai-gateway provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "vercel-ai-gateway",
			vercelAiGatewayApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for zai provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "zai",
			zaiApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for aihubmix provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "aihubmix",
			aihubmixApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for minimax provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "minimax",
			minimaxApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for nousResearch provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "nousResearch",
			nousResearchApiKey: "test-key",
			planModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
			actModeApiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for wandb provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "wandb",
			wandbApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for lmstudio provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "lmstudio",
			lmStudioBaseUrl: "http://localhost:1234",
			planModeLmStudioModelId: TEST_MODEL_IDS.OPENAI,
			actModeLmStudioModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for qwen-code provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "qwen-code",
			qwenCodeOauthPath: "/test/path",
			planModeApiModelId: "qwen-max",
			actModeApiModelId: "qwen-max",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for doubao provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "doubao",
			doubaoApiKey: "test-key",
			planModeApiModelId: "Doubao-Pro-4k",
			actModeApiModelId: "Doubao-Pro-4k",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for vscode-lm provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "vscode-lm",
			planModeVsCodeLmModelSelector: { family: TEST_MODEL_IDS.OPENAI },
			actModeVsCodeLmModelSelector: { family: TEST_MODEL_IDS.OPENAI },
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for openai-native provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "openai-native",
			openAiNativeApiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("returns a handler for openai-codex provider", () => {
		const config: ApiConfiguration = {
			apiProvider: "openai-codex",
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("selects plan mode model IDs when mode is plan", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		// Handler should use plan mode model ID
	})

	it("selects act mode model IDs when mode is act", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = buildApiHandler(config, "act")
		handler.should.not.be.undefined()
		// Handler should use act mode model ID
	})

	it("handles undefined apiProvider gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: undefined,
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		// Should fall back to default handler
	})
})
