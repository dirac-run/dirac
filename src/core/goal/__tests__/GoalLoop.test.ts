import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StateManager } from "@core/storage/StateManager"
import type { Task } from "@core/task"
import type { TaskRunOutcome } from "@core/task/TaskRunOutcome"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, it } from "mocha"
import pWaitFor from "p-wait-for"
import sinon from "sinon"
import { createGoalHistoryItem } from "../GoalHistory"
import { GoalLoop } from "../GoalLoop"
import { GoalStore } from "../GoalStore"
import type { GoalTaskFactory } from "../GoalTaskFactory"

describe("Goal follow-up execution", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "goal-followup-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
	})

	afterEach(async () => {
		sinon.restore()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("runs from the same Goal history without changing an achieved lifecycle status", async () => {
		const harness = await createFollowUpHarness("achieved")

		await harness.loop.sendMessage("Explain what was implemented")

		assert.equal(harness.loop.isFollowUpActive, true)
		assert.equal(harness.createdWith.executionProfile, "goal_followup")
		assert.equal(harness.createdWith.historyItem.id, harness.goalId)
		const resumeOptions = harness.coordinator.resumeTaskFromHistory.firstCall.args[1]
		assert.equal(resumeOptions.initialUserInput.text, "Explain what was implemented")
		assert.match(resumeOptions.systemContext, /durable Goal status remains achieved/)

		harness.resolveRun({ kind: "completed", response: "Done", completedAt: Date.now() })
		await pWaitFor(() => !harness.loop.hasRunningCoordinator)

		assert.equal((await harness.store.read(harness.goalId)).status, "achieved")
		assert.equal((await harness.loop.inspect()).followUpActive, false)
	})

	it("cancels only the follow-up turn for an inactive Goal", async () => {
		const harness = await createFollowUpHarness("paused")
		harness.coordinator.abortTask.callsFake(async () => {
			harness.resolveRun({ kind: "cancelled", reason: "Cancelled by user", cancelledAt: Date.now() })
		})

		await harness.loop.sendMessage("Check one more thing")
		await harness.loop.cancelCurrentExecution("Cancelled by user")

		assert.equal(harness.coordinator.abortTask.calledOnce, true)
		assert.equal((await harness.store.read(harness.goalId)).status, "paused")
		assert.equal(harness.loop.hasRunningCoordinator, false)
	})
})

async function createFollowUpHarness(status: "paused" | "achieved") {
	const goalId = "1787700000123"
	const initialDisplayText = "/goal Ship it"
	const store = new GoalStore()
	let record = await store.create(goalId, "01M0TW092EXA0KHTW38ZXJ1GCQ", "Ship it")
	if (status === "achieved") {
		record = await store.transition(goalId, { status: "working" })
		record = await store.transition(goalId, { status: "achieved" })
	}
	const history: HistoryItem[] = [createGoalHistoryItem(record, initialDisplayText, "/workspace/dirac")]
	const stateManager = {
		getGlobalStateKey: (key: string) => {
			assert.equal(key, "taskHistory")
			return history
		},
	} as unknown as StateManager

	let resolveRun!: (outcome: TaskRunOutcome) => void
	const run = new Promise<TaskRunOutcome>((resolve) => {
		resolveRun = resolve
	})
	const coordinator = {
		resumeTaskFromHistory: sinon.stub().returns(run),
		enqueueSteeringMessage: sinon.stub().resolves(),
		abortTask: sinon.stub().resolves(),
	} as unknown as Task & {
		resumeTaskFromHistory: sinon.SinonStub
		enqueueSteeringMessage: sinon.SinonStub
		abortTask: sinon.SinonStub
	}
	let createdWith: any
	const taskFactory = {
		create: async (input: any) => {
			createdWith = input
			return coordinator
		},
	} as unknown as GoalTaskFactory
	const loop = new GoalLoop({
		goalId,
		initialDisplayText,
		store,
		createTaskFactory: () => taskFactory,
		stateManager,
		updateHistory: async (item) => {
			history[0] = item
			return history
		},
		postState: async () => {},
		workspaceRootPath: "/workspace/dirac",
	})

	return { goalId, store, loop, coordinator, resolveRun, get createdWith() { return createdWith } }
}
