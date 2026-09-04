import { strict as assert } from "node:assert"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import { AgentConfigLoader } from "@core/task/tools/subagent/AgentConfigLoader"
import { SubagentRunner } from "@core/task/tools/subagent/SubagentRunner"
import { SubagentRunRecorder } from "@core/task/tools/subagent/SubagentRunRecorder"
import { SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { buildOrchestrationTrait } from "../OrchestrationTraitBuilder"

describe("OrchestrationTraitBuilder Utility subagent routing", () => {
	afterEach(() => sinon.restore())

	it("rejects Utility routing when no valid Utility model is configured", async () => {
		const { config } = createMockTaskConfig()
		const trait = buildOrchestrationTrait(config)

		await assert.rejects(() => trait.runSubagent("Investigate", { useUtilityModel: true }), /Utility model is not configured/)
	})

	it("passes the configured Utility selection to the subagent runner", async () => {
		const utilityModelSelection = { provider: "openrouter" as const, modelId: "utility/model" }
		const { config } = createMockTaskConfig({
			overrides: { utilityModelSelection },
		})
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: () => undefined,
		} as unknown as AgentConfigLoader)
		const createSubagentRuntime = config.callbacks.createSubagentRuntime as sinon.SinonStub
		const recorder = { flush: sinon.stub().resolves() }
		const createRecorder = sinon.stub(SubagentRunRecorder, "create").resolves(recorder as never)
		const completedResult = {
			status: SubagentExecutionStatus.COMPLETED,
			result: "done",
			stats: {
				toolCalls: 0, inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0,
				totalCost: 0.5, contextTokens: 15, contextWindow: 1000, contextUsagePercentage: 1.5,
			},
		}
		const run = sinon.stub(SubagentRunner.prototype, "run").resolves(completedResult as never)
		const trait = buildOrchestrationTrait(config)

		const result = await trait.runSubagent("Investigate", {
			useUtilityModel: true,
			taskTitle: "Utility investigation",
			timeout: 45,
			includeHistory: true,
		})

		assert.equal(result, completedResult)
		const usageMessages = config.messageState.addToDiracMessages.args.map(([message]: [any]) => message)
		assert.equal(getApiMetrics(usageMessages).totalCost, 0.5)
		sinon.assert.calledOnceWithExactly(createSubagentRuntime, {
			modelId: undefined,
			utilityModelSelection,
		})
		const recorderOptions = createRecorder.firstCall.args[0]
		assert.equal(recorderOptions.providerId, "openrouter")
		assert.equal(recorderOptions.modelId, "utility/model")
		assert.equal(recorderOptions.timeoutSeconds, 45)
		assert.equal(recorderOptions.includeHistory, true)
		const [prompt, onUpdate, timeout, includeHistory] = run.firstCall.args
		assert.equal(prompt, "Investigate")
		assert.equal(typeof onUpdate, "function")
		assert.equal(timeout, 45)
		assert.equal(includeHistory, true)
	})
})
