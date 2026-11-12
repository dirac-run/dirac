import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ToolExecutor } from "../ToolExecutor"
import { createTaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import { TASK_CALLBACKS_KEYS } from "../tools/utils/ToolConstants"

function configuration(subagentsEnabled: boolean, revision = 1) {
	return createTaskWorkingConfiguration({
		revision,
		settings: { mode: "act", subagentsEnabled, strictPlanModeEnabled: true } as any,
		apiConfiguration: {} as any,
		workspaceConfiguration: {} as any,
		executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
	})
}

describe("ToolExecutor shared root tasklet eligibility", () => {
	for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) {
		it(`binds controls only for owning roots (${executionProfile})`, () => {
			const workingConfiguration = configuration(true)
			const runtime = createTaskRequestRuntime(workingConfiguration, { getModel: () => ({ id: "fixture", info: {} }) } as any, "request")
			const controls = { list: () => [] }
			const getTaskletControls = sinon.stub().returns(controls)
			const executor = Object.assign(Object.create(ToolExecutor.prototype), {
				executionProfile,
				agentRole: "Saved Reviewer",
				requestRuntime: () => runtime,
				getCurrentWorkingConfiguration: () => workingConfiguration,
				getTaskletControls,
				commandPermissionController: {},
				createPermissionDecisionBinding: sinon.stub(),
			})
			for (const key of TASK_CALLBACKS_KEYS) {
				if (typeof executor[key] !== "function") executor[key] = sinon.stub()
			}
			const config = executor.asToolConfig()
			assert.equal(config.agentRole, "Saved Reviewer")
			assert.equal(config.callbacks.tasklets, executionProfile === "tasklet" ? undefined : controls)
			assert.equal(getTaskletControls.callCount, executionProfile === "tasklet" ? 0 : 1)
		})
	}

	it("invalidates cached inventory when request-bound spawning eligibility changes", async () => {
		const markDirty = sinon.stub()
		const getSnapshotForRequest = sinon.stub().resolves({})
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			snapshotManager: { markDirty, getSnapshotForRequest },
		})
		for (const [index, enabled] of [true, true, false, false, true].entries()) {
			const runtime = createTaskRequestRuntime(configuration(enabled, index + 1), {} as any, `request-${index}`)
			await executor.getSnapshotForRequest({ subagentsEnabled: enabled }, runtime)
			assert.equal(executor.buildingRequestRuntime, undefined)
		}
		assert.equal(markDirty.callCount, 3)
		for (const call of markDirty.getCalls()) assert.deepEqual(call.args, ["tool_toggles_changed"])
		assert.equal(getSnapshotForRequest.callCount, 5)
	})
})
