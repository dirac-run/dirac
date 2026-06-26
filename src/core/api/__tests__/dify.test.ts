/**
 * Characterization tests for Dify provider (ORIGINAL codebase).
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

describe("Dify Provider (original)", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
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

	it("handles missing difyApiKey gracefully", () => {
		const config: ApiConfiguration = {
			apiProvider: "dify",
			difyApiKey: undefined,
			planModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
			actModeApiModelId: TEST_MODEL_IDS.ANTHROPIC,
		}
		const handler = buildApiHandler(config, "plan")
		handler.should.not.be.undefined()
		handler.should.have.property("createMessage")
	})
})
