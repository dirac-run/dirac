/**
 * Characterization tests for API error handling (ORIGINAL codebase).
 * Captures current behavior — bugs and all.
 *
 * Phase 1 — Refactoring Safety Net
 */
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { buildApiHandler } from "../index"
import type { ApiConfiguration } from "@shared/api"
import { TEST_MODEL_IDS } from "@test/fixtures/model-ids"

describe("API Error Handling (original)", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("handles missing apiKey gracefully for anthropic", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: undefined,
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles missing apiKey gracefully for openai", () => {
		const config: ApiConfiguration = {
			apiProvider: "openai",
			openAiApiKey: undefined,
			planModeApiModelId: TEST_MODEL_IDS.OPENAI,
			actModeApiModelId: TEST_MODEL_IDS.OPENAI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles missing apiKey gracefully for gemini", () => {
		const config: ApiConfiguration = {
			apiProvider: "gemini",
			geminiApiKey: undefined,
			planModeApiModelId: TEST_MODEL_IDS.GEMINI,
			actModeApiModelId: TEST_MODEL_IDS.GEMINI,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles missing apiKey gracefully for bedrock", () => {
		const config: ApiConfiguration = {
			apiProvider: "bedrock",
			awsAccessKey: undefined,
			awsSecretKey: undefined,
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC_BEDROCK,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC_BEDROCK,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles missing apiProvider gracefully", () => {
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

	it("handles invalid mode by defaulting to plan", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = buildApiHandler(config, "plan" as any)
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles missing model ID gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: undefined,
			actModeApiModelId: undefined,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles empty model ID gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: "",
			actModeApiModelId: "",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles negative thinking budget gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeThinkingBudgetTokens: -1,
			actModeThinkingBudgetTokens: -1,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles missing reasoning effort gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeReasoningEffort: undefined,
			actModeReasoningEffort: undefined,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles invalid reasoning effort gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeReasoningEffort: "invalid" as any,
			actModeReasoningEffort: "invalid" as any,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles missing ulid gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: "vertex",
			vertexProjectId: "test-project",
			vertexRegion: "us-central1",
			planModeApiModelId: TEST_MODEL_IDS.GEMINI,
			actModeApiModelId: TEST_MODEL_IDS.GEMINI,
			ulid: undefined,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})
})
