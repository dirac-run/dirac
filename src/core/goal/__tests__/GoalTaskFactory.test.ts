import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { ApiConfiguration } from "@shared/api"
import type { Settings } from "@shared/storage/state-keys"
import * as taskModule from "@core/task"
import type { TaskParams } from "@core/task"
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

describe("GoalTaskFactory root construction", () => {
	afterEach(() => sinon.restore())

	for (const executionProfile of ["goal_coordinator", "goal_followup"] as const) {
		for (const hooksEnabled of [true, false]) {
			it(`inherits the current configuration for ${executionProfile} with hooks ${hooksEnabled ? "enabled" : "disabled"}`, async () => {
				const source = configuration(hooksEnabled)
				const constructed = sinon.stub(taskModule, "Task").callsFake(function (params: TaskParams) {
					return { params } as unknown as taskModule.Task
				})
				const postCoordinatorState = sinon.stub().resolves()
				const factory = new GoalTaskFactory({
					workingConfiguration: source,
					postCoordinatorState,
				} as unknown as ConstructorParameters<typeof GoalTaskFactory>[0])
				const environmentFactory = {} as Parameters<GoalTaskFactory["create"]>[0]["environmentFactory"]

				await factory.create({
					id: "goal",
					conversationUlid: "conversation",
					executionProfile,
					environmentFactory,
					onHistorySnapshot: async () => { },
				})

				const params = constructed.firstCall.args[0] as TaskParams
				assert.strictEqual(params.workingConfiguration, source)
				assert.equal(params.workingConfiguration?.settings.hooksEnabled, hooksEnabled)
				assert.equal(params.executionProfile, executionProfile)
				assert.equal(params.releaseTaskLock, undefined)
				assert.strictEqual(params.toolEnvironmentFactory, environmentFactory)
				assert.strictEqual(params.postStateToWebview, postCoordinatorState)
			})
		}
	}
})
