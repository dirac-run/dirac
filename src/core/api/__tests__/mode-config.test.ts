/**
 * Characterization tests for mode configuration (ORIGINAL codebase).
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

describe("Mode Configuration (original)", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("selects plan mode model ID when mode is plan", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("selects act mode model ID when mode is act", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = buildApiHandler(config, "act")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("selects plan mode thinking budget when mode is plan", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeThinkingBudgetTokens: 20000,
			actModeThinkingBudgetTokens: 10000,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("selects act mode thinking budget when mode is act", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeThinkingBudgetTokens: 20000,
			actModeThinkingBudgetTokens: 10000,
		}
		const handler = buildApiHandler(config, "act")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("selects plan mode reasoning effort when mode is plan", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeReasoningEffort: "high",
			actModeReasoningEffort: "medium",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("selects act mode reasoning effort when mode is act", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeReasoningEffort: "high",
			actModeReasoningEffort: "medium",
		}
		const handler = buildApiHandler(config, "act")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})

	it("handles undefined plan mode config by falling back to act mode", () => {
		const config: ApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
			planModeApiModelId: undefined,
			actModeApiModelId: "claude-3-haiku",
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})
})
