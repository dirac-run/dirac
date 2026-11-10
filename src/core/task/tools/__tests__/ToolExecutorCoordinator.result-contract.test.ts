import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { IToolEnvironment } from "../interfaces/IToolEnvironment"
import { createMockTaskConfig } from "./helpers/mockTaskConfig"

class InvalidResultTool implements IDiracTool<unknown, any> {
	constructor(private readonly result: unknown) { }

	spec(): DiracToolSpec {
		return { id: DiracDefaultTool.RESPOND, name: DiracDefaultTool.RESPOND, description: "test", parameters: [] }
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(_args: unknown, _env: IToolEnvironment): Promise<any> {
		return this.result
	}
}

function block() {
	return {
		type: "tool_use" as const,
		name: DiracDefaultTool.RESPOND,
		params: {},
	}
}

describe("ToolExecutorCoordinator result contract", () => {
	for (const testCase of [
		{ name: "undefined", value: undefined },
		{ name: "a plain object", value: { status: "ok" } },
		{ name: "an unsupported content block", value: [{ type: "json", value: {} }] },
	]) {
		it(`converts ${testCase.name} into a normal tool failure`, async () => {
			const { config, taskState } = createMockTaskConfig()
			const coordinator = new ToolExecutorCoordinator()
			coordinator.registerModularTool(new InvalidResultTool(testCase.value))

			const result = await coordinator.execute(config, block())

			assert.match(result.content as string, /returned an invalid result/)
			assert.deepEqual(result.effects, { mistake: "increment" })
			assert.equal(taskState.consecutiveMistakeCount, 0)
		})
	}
})
