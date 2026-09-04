import { strict as assert } from "node:assert"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import { AgentConfigLoader } from "@core/task/tools/subagent/AgentConfigLoader"
import { SubagentRunner } from "@core/task/tools/subagent/SubagentRunner"
import { SubagentRunRecorder } from "@core/task/tools/subagent/SubagentRunRecorder"
import { SubagentExecutionStatus } from "@shared/ExtensionMessage"
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
			stats: {},
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

describe("OrchestrationTraitBuilder runSubagent abort signal propagation (FB-29)", () => {
	let abortStub: sinon.SinonStub
	let runStub: sinon.SinonStub

	beforeEach(() => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: () => undefined,
		} as unknown as AgentConfigLoader)
		sinon.stub(SubagentRunRecorder, "create").resolves({ flush: sinon.stub().resolves() } as never)
		abortStub = sinon.stub(SubagentRunner.prototype, "abort").resolves()
		runStub = sinon.stub(SubagentRunner.prototype, "run")
	})

	afterEach(() => sinon.restore())

	it("aborts the runner immediately when the signal is already aborted (pre-abort)", async () => {
		const { config } = createMockTaskConfig()
		const trait = buildOrchestrationTrait(config)

		const controller = new AbortController()
		controller.abort(new Error("Pre-aborted"))

		runStub.resolves({ status: SubagentExecutionStatus.CANCELLED, stats: {} } as never)

		await trait.runSubagent("Investigate", { signal: controller.signal })

		sinon.assert.calledOnce(abortStub)
		sinon.assert.calledWith(abortStub, "Aborted by external signal")
	})

	it("calls runner.abort() immediately when the signal aborts mid-run", async () => {
		const { config } = createMockTaskConfig()
		const trait = buildOrchestrationTrait(config)

		const controller = new AbortController()
		let releaseRun: (result: any) => void = () => {}
		runStub.returns(
			new Promise((resolve) => {
				releaseRun = resolve
			}),
		)

		const runPromise = trait.runSubagent("Investigate", { signal: controller.signal })

		// Abort while the run is in-flight
		controller.abort(new Error("Mid-run abort"))
		await Promise.resolve()
		await Promise.resolve()

		sinon.assert.calledOnce(abortStub)

		releaseRun({ status: SubagentExecutionStatus.CANCELLED, stats: {} })
		await runPromise
	})

	it("does not call runner.abort() when the signal aborts after the run completed (post-completion)", async () => {
		const { config } = createMockTaskConfig()
		const trait = buildOrchestrationTrait(config)

		const controller = new AbortController()
		runStub.resolves({ status: SubagentExecutionStatus.COMPLETED, result: "done", stats: {} } as never)

		await trait.runSubagent("Investigate", { signal: controller.signal })

		// Late parent abort after the run finished
		controller.abort(new Error("Late abort"))

		sinon.assert.notCalled(abortStub)
	})

	it("runs normally without an abort signal", async () => {
		const { config } = createMockTaskConfig()
		const trait = buildOrchestrationTrait(config)

		const completedResult = { status: SubagentExecutionStatus.COMPLETED, result: "done", stats: {} }
		runStub.resolves(completedResult as never)

		const result = await trait.runSubagent("Investigate")

		assert.equal(result, completedResult)
		sinon.assert.notCalled(abortStub)
	})

	it("removes the abort listener after the run finishes so repeated runs don't leak listeners", async () => {
		const { config } = createMockTaskConfig()
		const trait = buildOrchestrationTrait(config)

		const controller = new AbortController()
		runStub.resolves({ status: SubagentExecutionStatus.COMPLETED, result: "done", stats: {} } as never)

		await trait.runSubagent("First run", { signal: controller.signal })
		await trait.runSubagent("Second run", { signal: controller.signal })

		// Abort after both runs finished — neither run's listener should fire
		controller.abort(new Error("Late abort"))

		sinon.assert.notCalled(abortStub)
	})
})
