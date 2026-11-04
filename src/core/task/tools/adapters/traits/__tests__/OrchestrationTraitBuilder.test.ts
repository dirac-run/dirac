import { strict as assert } from "node:assert"
import { createMockTaskConfig } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { buildOrchestrationTrait } from "../OrchestrationTraitBuilder"

describe("OrchestrationTraitBuilder", () => {
	afterEach(() => sinon.restore())

	for (const contained of [false, true]) {
		it(`forwards ${contained ? "contained" : "root"} skill storage`, async () => {
			const { config } = createMockTaskConfig()
			if (contained)
				config.storageAddress = {
					kind: "tasklet",
					rootTaskId: "root",
					taskletId: "tasklet_00000000-0000-4000-8000-000000000001",
				}
			const activate = sinon.stub(require("@core/task/activateTaskSkill"), "activateTaskSkill").resolves()
			await buildOrchestrationTrait(config).activateSkill("skill")
			sinon.assert.calledOnceWithExactly(activate, config.storageAddress ?? config.taskId, config.taskState, "skill")
		})
	}

	for (const executionProfile of ["standalone", "tasklet", "goal_coordinator", "goal_followup", "goal_child"] as const) {
		it(`has no synchronous delegation entry point or runtime callback for ${executionProfile}`, () => {
			const { config } = createMockTaskConfig({ overrides: { executionProfile } })
			assert.equal("runSubagent" in buildOrchestrationTrait(config), false)
			assert.equal("createSubagentRuntime" in config.callbacks, false)
		})
	}
})
