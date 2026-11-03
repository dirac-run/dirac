import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { toolSpecFunctionDefinition } from "@core/prompts/system-prompt/spec"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { TaskletControls } from "../interfaces/IToolEnvironment"
import type { ToolExecutionEnvironment } from "../interfaces/ToolEnvironmentFactory"
import { TaskletsTool, tasklets_spec } from "../modules/use_subagents/UseSubagentsTool"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { createMockTaskConfig } from "./helpers/mockTaskConfig"

function fixture(strict = true) {
	const { config, context } = createMockTaskConfig({ overrides: { isSubagentExecution: false } })
	const controls = {
		list: sinon.stub().returns([]),
		sleep: sinon.stub().resolves({ reason: "timeout" }),
		resolveInteraction: sinon.stub().resolves({ status: "resolved" }),
	}
	const card = {
		id: "tasklets-card",
		status: CardStatus.RUNNING,
		update: sinon.stub().resolves(),
		finalize: sinon.stub().callsFake(async (status: CardStatus) => { card.status = status }),
	}
	const createCard = sinon.stub().resolves(card)
	const save = sinon.stub().resolves()
	const environment = {
		orchestration: { tasklets: controls as unknown as TaskletControls },
		ui: { createCard },
		context: { ...context, save },
		telemetry: { captureCustomMetadata: sinon.stub() },
		getCreatedCards: () => createCard.called ? [card] : [],
		getCustomMetadata: () => ({}),
	} as unknown as ToolExecutionEnvironment
	const create = sinon.stub().returns(environment)
	const coordinator = new ToolExecutorCoordinator({ create })
	coordinator.registerModularTool(new TaskletsTool())
	config.activeToolSnapshot = {
		inventoryVersion: 1,
		requestId: "tasklets-request",
		promptVisibleSpecs: [tasklets_spec],
		inventoryEnabledTools: [],
		activeSkillIds: [],
		nativeTools: [toolSpecFunctionDefinition(tasklets_spec, { cwd: config.cwd } as SystemPromptContext, strict)],
		coordinator,
		executableToolNames: new Set(["tasklets"]),
		dynamicSubagentToolNames: new Set(),
	}
	const execute = (parameters: Record<string, unknown>) => coordinator.execute(config, {
		type: "tool_use", name: "tasklets", params: parameters, isNativeToolCall: true,
	})
	return { controls, card, createCard, save, create, config, execute }
}

function strictArguments(operation: string, overrides: Record<string, unknown> = {}) {
	return {
		...Object.fromEntries(tasklets_spec.parameters!.filter((parameter) => !parameter.required).map((parameter) => [parameter.name, null])),
		operation,
		...overrides,
	}
}

describe("ToolExecutorCoordinator tasklets strict input normalization", () => {
	it("executes list with every optional field null through injected parent controls", async () => {
		const { controls, card, createCard, save, create, config, execute } = fixture()
		assert.deepEqual(JSON.parse(await execute(strictArguments("list")) as string), [])
		sinon.assert.calledOnceWithExactly(controls.list)
		sinon.assert.notCalled(controls.sleep)
		assert.deepEqual(create.firstCall.args[0].toolUse, { name: "tasklets", params: { operation: "list" } })
		assert.equal(create.firstCall.args[1], "tasklets")
		assert.deepEqual(createCard.firstCall.args[0].rawInput, { operation: "list" })
		sinon.assert.calledOnce(save)
		assert.equal(card.status, CardStatus.SUCCESS)
		assert.equal(config.taskState.consecutiveMistakeCount, 0)
	})

	for (const parameters of [
		{},
		{ timeout_ms: 0 },
		{ tasklet_ids: [], timeout_ms: 0 },
		{ tasklet_ids: ["child-1"] },
	]) {
		it(`executes sleep with null optional fields and preserves ${JSON.stringify(parameters)}`, async () => {
			const { controls, card, save, execute } = fixture()
			assert.deepEqual(JSON.parse(await execute(strictArguments("sleep", parameters)) as string), { reason: "timeout" })
			sinon.assert.calledOnceWithExactly(controls.sleep, {
				taskletIds: parameters.tasklet_ids,
				timeoutMs: parameters.timeout_ms,
			})
			sinon.assert.notCalled(controls.list)
			sinon.assert.calledOnce(save)
			assert.equal(card.status, CardStatus.SUCCESS)
		})
	}

	it("does not normalize nulls for non-strict calls", async () => {
		const { controls, createCard, save, execute } = fixture(false)
		assert.match(await execute(strictArguments("list")) as string, /Parameter 'tasklet_id' is not valid for list/)
		sinon.assert.notCalled(controls.list)
		sinon.assert.notCalled(createCard)
		sinon.assert.notCalled(save)
	})

	for (const { name, input, response } of [
		{
			name: "free-text answer",
			input: { answer: "Continue with option two" },
			response: { action: DiracAskResponse.MESSAGE, response: DiracAskResponse.MESSAGE, text: "Continue with option two" },
		},
		{
			name: "displayed choice value with answer",
			input: { action: "choice-2", answer: "Use option two" },
			response: { action: "choice-2", response: DiracAskResponse.MESSAGE, value: "choice-2", text: "Use option two" },
		},
		{
			name: "operational Retry action without granting permission",
			input: { action: DiracAskResponse.APPROVE },
			response: { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE, value: DiracAskResponse.APPROVE },
		},
	]) {
		it(`preserves ${name} after strict normalization`, async () => {
			const { controls, execute } = fixture()
			const result = await execute(strictArguments("resolve", {
				tasklet_id: "child-1", request_id: "request-1", resolution: "answer", ...input,
			}))
			assert.deepEqual(JSON.parse(result as string), { status: "resolved" })
			sinon.assert.calledOnceWithExactly(controls.resolveInteraction, "child-1", "request-1", { operation: "answer", response })
		})
	}
})
