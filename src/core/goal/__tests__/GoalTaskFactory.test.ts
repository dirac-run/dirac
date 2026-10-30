import assert from "node:assert/strict"
import { describe, it } from "mocha"
import type { ApiConfiguration } from "@shared/api"
import type { Settings } from "@shared/storage/state-keys"
import {
	createTaskWorkingConfiguration,
	type TaskWorkingConfiguration,
	type TaskWorkingConfigurationInput,
} from "@core/task/runtime/TaskWorkingConfiguration"
import { GoalTaskFactory } from "../GoalTaskFactory"

function configuration(hooksEnabled: boolean): TaskWorkingConfiguration {
	return createTaskWorkingConfiguration({
		settings: { hooksEnabled } as Settings,
		apiConfiguration: {} as ApiConfiguration,
		workspaceConfiguration: {} as TaskWorkingConfigurationInput["workspaceConfiguration"],
		executionOptions: {
			terminalReuseEnabled: false,
			vscodeTerminalExecutionMode: "backgroundExec",
			multiRootEnabled: false,
		},
	})
}

describe("GoalTaskFactory working configuration", () => {
	it("disables hooks for children without changing the owning Goal configuration", () => {
		const source = configuration(true)
		const factory = new GoalTaskFactory({ workingConfiguration: source } as ConstructorParameters<typeof GoalTaskFactory>[0])
		const workingConfiguration = factory["workingConfiguration"].bind(factory)

		const child = workingConfiguration("goal_child")
		assert.equal(child.settings.hooksEnabled, false)
		assert.strictEqual(workingConfiguration("goal_coordinator"), source)
		assert.strictEqual(workingConfiguration("goal_followup"), source)
		assert.equal(source.settings.hooksEnabled, true)
	})

	it("reuses the configuration when child hooks are already disabled", () => {
		const source = configuration(false)
		const factory = new GoalTaskFactory({ workingConfiguration: source } as ConstructorParameters<typeof GoalTaskFactory>[0])

		assert.strictEqual(factory["workingConfiguration"]("goal_child"), source)
	})
})
