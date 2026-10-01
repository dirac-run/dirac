import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Controller } from "@core/controller"
import type { StateManager } from "@core/storage/StateManager"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { GoalController } from "../GoalController"
import { createGoalHistoryItem } from "../GoalHistory"
import { GoalLoop } from "../GoalLoop"
import { GoalTaskFactory } from "../GoalTaskFactory"
import type { Task } from "@core/task"
import type { TaskWorkingConfiguration } from "@core/task/runtime/TaskWorkingConfiguration"
import pWaitFor from "p-wait-for"
import { GoalStore } from "../GoalStore"

describe("GoalController startup transaction", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "goal-controller-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
	})

	afterEach(async () => {
		sinon.restore()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("rolls back the Goal record without publishing history when loop construction fails", async () => {
		const history: import("@shared/HistoryItem").HistoryItem[] = []
		let historyWrites = 0
		const stateManager = {
			getGlobalStateKey: (key: string) => {
				assert.equal(key, "taskHistory")
				return history
			},
		} as unknown as StateManager
		const controller = {
			ensureWorkspaceManager: async () => undefined,
		} as unknown as Controller
		const goalController = new GoalController({
			controller,
			stateManager,
			getStandaloneTask: () => undefined,
			clearStandaloneTask: async () => {},
			updateGoalHistory: async (item) => {
				historyWrites += 1
				history.push(item)
				return history
			},
			postState: async () => {},
		})

		await assert.rejects(goalController.start("Ship it"), /initialized workspace manager/)

		assert.equal(historyWrites, 0)
		assert.deepEqual(history, [])
		assert.equal(goalController.selectedGoalId, undefined)
		assert.deepEqual(await new GoalStore().list(), [])
	})

	it("creates top-level Goal IDs in the ordinary Task timestamp format", async () => {
		const clock = sinon.useFakeTimers({ now: 1_787_700_000_123 })
		const startStub = sinon.stub(GoalLoop.prototype, "start").resolves()
		try {
			const history: HistoryItem[] = []
			const stateManager = {
				getGlobalStateKey: () => history,
				captureEffectiveTaskConfiguration: () => ({}),
			} as unknown as StateManager
			const controller = {
				ensureWorkspaceManager: async () => ({
					getPrimaryRoot: () => ({ path: "/workspace/dirac" }),
				}),
			} as unknown as Controller
			const goalController = new GoalController({
				controller,
				stateManager,
				getStandaloneTask: () => undefined,
				clearStandaloneTask: async () => {},
				updateGoalHistory: async (item) => {
					history.push(item)
					return history
				},
				postState: async () => {},
			})

			const goalId = await goalController.start("Ship it")
			const record = await new GoalStore().read(goalId)

			assert.equal(goalId, "1787700000123")
			assert.match(record.conversationUlid, /^[0-9A-HJKMNP-TV-Z]{26}$/)
			assert.equal(history.length, 1)
			assert.equal(history[0].id, goalId)
			assert.equal(history[0].workspaceRootPath, "/workspace/dirac")
		} finally {
			startStub.restore()
			clock.restore()
		}
	})

	it("preserves an existing Goal workspace while reconciling startup lifecycle state", async () => {
		const goalId = "01M0TW092EXA0KHTW38ZXJ1GCQ"
		const store = new GoalStore()
		await store.create(goalId, "01M0TW092EXA0KHTW38ZXJ1GCQ", "Review the implementation")
		const working = await store.transition(goalId, { status: "working" })
		const history: HistoryItem[] = [
			{
				...createGoalHistoryItem(working, "Review the implementation", "/workspace/original"),
				isFavorited: true,
			},
		]
		let workspaceInitializations = 0
		const stateManager = {
			getGlobalStateKey: () => history,
		} as unknown as StateManager
		const controller = {
			ensureWorkspaceManager: async () => {
				workspaceInitializations += 1
				return { getPrimaryRoot: () => ({ path: "/workspace/restarting" }) }
			},
		} as unknown as Controller
		const goalController = new GoalController({
			controller,
			stateManager,
			getStandaloneTask: () => undefined,
			clearStandaloneTask: async () => {},
			updateGoalHistory: async (item) => {
				history[0] = { ...item, isFavorited: history[0].isFavorited }
				return history
			},
			postState: async () => {},
		})

		assert.equal(await goalController.inspect(), undefined)

		assert.equal(workspaceInitializations, 0)
		assert.equal(history[0].id, goalId)
		assert.equal(history[0].workspaceRootPath, "/workspace/original")
		assert.equal(history[0].isFavorited, true)
		assert.equal(history[0].runKind === "goal" ? history[0].status : undefined, "paused")
	})

	it("captures current Act settings for each follow-up after an inactive Goal's Utility setting changes", async () => {
		const goalId = "1787700000888"
		const store = new GoalStore()
		const record = await store.create(goalId, "01M0TW092EXA0KHTW38ZXJ1GCQ", "Review Goal")
		const history: HistoryItem[] = [createGoalHistoryItem(record, "Review Goal", "/workspace/dirac")]
		let configuration = {
			settings: { mode: "act", utilityModelUseCondense: true, utilityModelSelection: { provider: "openai-codex", modelId: "gpt-6-luna" } },
			apiConfiguration: {
				planModeApiProvider: "openai-codex", planModeApiModelId: "gpt-6-astra",
				actModeApiProvider: "openai-codex", actModeApiModelId: "gpt-6.1-sol",
			},
		} as unknown as TaskWorkingConfiguration
		const capture = sinon.stub().callsFake((overrides) => {
			assert.deepEqual(overrides, { mode: "act" })
			return configuration
		})
		const stateManager = {
			getGlobalStateKey: () => history,
			captureEffectiveTaskConfiguration: capture,
		} as unknown as StateManager
		const capturedConfigurations: TaskWorkingConfiguration[] = []
		sinon.stub(GoalTaskFactory.prototype, "create").callsFake(async function (this: GoalTaskFactory, input) {
			capturedConfigurations.push(this["workingConfiguration"](input.executionProfile, input.childRole))
			return {
				resumeTaskFromHistory: async () => ({ kind: "completed", response: "Done", completedAt: Date.now() }),
			} as unknown as Task
		})
		const goalController = new GoalController({
			controller: { ensureWorkspaceManager: async () => ({ getPrimaryRoot: () => ({ path: "/workspace/dirac" }) }) } as unknown as Controller,
			stateManager,
			getStandaloneTask: () => undefined,
			clearStandaloneTask: async () => { },
			updateGoalHistory: async (item) => { history[0] = item; return history },
			postState: async () => { },
		})

		await goalController.select(goalId)
		assert.equal(capture.callCount, 0)
		await goalController.sendMessage(goalId, "Continue")
		await pWaitFor(() => !goalController.hasRunningCoordinator)
		assert.equal(capturedConfigurations[0].settings.utilityModelUseCondense, true)

		configuration = {
			...configuration,
			settings: { ...configuration.settings, utilityModelUseCondense: false },
		}
		await goalController.sendMessage(goalId, "Continue without Utility")
		await pWaitFor(() => !goalController.hasRunningCoordinator)

		assert.equal(capture.callCount, 2)
		assert.equal(capturedConfigurations[1].settings.utilityModelUseCondense, false)
		assert.equal(capturedConfigurations[1].settings.mode, "act")
		assert.equal(capturedConfigurations[1].apiConfiguration.actModeApiModelId, "gpt-6.1-sol")
		assert.equal(capturedConfigurations[0].settings.utilityModelUseCondense, true)
	})

	it("loads with the existing task history when a persisted Goal has no matching entry", async () => {
		const store = new GoalStore()
		await store.create("1787700000999", "01M0TW092EXA0KHTW38ZXJ1GCQ", "Missing summary")
		const history: HistoryItem[] = [
			{ id: "existing-task", ts: 1, task: "Keep me", tokensIn: 0, tokensOut: 0, totalCost: 0 },
		]
		const stateManager = {
			getGlobalStateKey: () => history,
		} as unknown as StateManager
		const goalController = new GoalController({
			controller: {} as Controller,
			stateManager,
			getStandaloneTask: () => undefined,
			clearStandaloneTask: async () => {},
			updateGoalHistory: async () => {
				throw new Error("Missing Goal history must not be updated")
			},
			postState: async () => {},
		})

		assert.equal(await goalController.inspect(), undefined)
		assert.deepEqual(history.map((item) => item.id), ["existing-task"])
	})
})
