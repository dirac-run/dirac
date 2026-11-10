import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { DiracToolSpec } from "@shared/tools"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { IToolEnvironment } from "../interfaces/IToolEnvironment"
import { ToolTimeoutError } from "../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../runtime/ToolTimeoutPresentation"
import { createMockTaskConfig } from "./helpers/mockTaskConfig"

class TimedOutTool implements IDiracTool {
	spec(): DiracToolSpec {
		return { id: "timed_tool", name: "timed_tool", description: "test" }
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(_args: unknown, environment: IToolEnvironment): Promise<string> {
		const card = await environment.ui.createCard({ header: "Running timed tool" })
		return await presentToolTimeout(
			environment,
			new ToolTimeoutError("timed_tool", "reading data", 30_000),
			[card],
		)
	}
}

describe("ToolExecutorCoordinator timeout handling", () => {
	it("returns a typed model result after the tool terminalizes its timeout card", async () => {
		const { config, taskMessenger, taskState } = createMockTaskConfig()
		const coordinator = new ToolExecutorCoordinator()
		coordinator.registerModularTool(new TimedOutTool())

		const result = await coordinator.execute(config, {
			type: "tool_use",
			name: "timed_tool",
			params: {},
		})

		assert.match(result.content as string, /<timeout>/)
		assert.match(result.content as string, /Tool: timed_tool/)
		assert.match(result.content as string, /Operation: reading data/)
		assert.deepEqual(result.effects, { mistake: "increment" })
		assert.equal(taskState.consecutiveMistakeCount, 0)
		const cardHandle = await taskMessenger.createCard.firstCall.returnValue
		assert.equal(cardHandle.getCard().status, "error")
		assert.equal(cardHandle.getCard().outcome, "timeout")
	})
})
