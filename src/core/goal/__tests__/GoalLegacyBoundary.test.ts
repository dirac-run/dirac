import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller } from "@core/controller"
import { showTaskWithId } from "@core/controller/task/showTaskWithId"
import { deleteRunStorage, TaskHistoryController } from "@core/controller/TaskHistoryController"
import { repairMissingTaskHistory } from "@core/commands/repairMissingTaskHistory"
import { reconstructTaskHistory, reconstructTaskHistoryItem } from "@core/commands/reconstructTaskHistory"
import type { StateManager } from "@core/storage/StateManager"
import { ensureTaskDirectoryExists } from "@core/storage/directoryEnsurers"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import { getTaskHistoryStateFilePath, readTaskHistoryFromState } from "@core/storage/taskHistory"
import { acquireTaskLock } from "@core/task/TaskLockUtils"
import { CardStatus } from "@shared/ExtensionMessage"
import type { RunHistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { createTaskletFixtureId as createTaskletId } from "@/test/taskletFixtures"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { GoalController } from "../GoalController"
import { createGoalHistoryItem } from "../GoalHistory"
import { GoalStore } from "../GoalStore"

const GOAL_ID = "1788000000001"
const CHILD_ID = "1788000000002"
const OTHER_ID = "1788000000003"
const LEGACY_ERROR = /legacy execution format.*Create a new Goal with \/goal/

describe("Goal legacy storage boundary", () => {
	let storagePath: string
	let store: GoalStore

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "goal-legacy-boundary-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
		store = new GoalStore(() => 200)
	})

	afterEach(async () => {
		sinon.restore()
		HostProvider.reset()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	async function legacyGoal() {
		const current = await new GoalStore(() => 100).create(GOAL_ID, "conversation", "Legacy objective")
		const legacy = {
			...current,
			version: 1,
			status: "waiting",
			lastActivatedAt: 100,
			eventSequence: 1,
			events: [{ kind: "task_interaction", sequence: 1, taskId: CHILD_ID, interactionId: "request", occurredAt: 100 }],
			children: [
				{
					id: CHILD_ID,
					title: "Private legacy child",
					role: "task",
					status: "waiting",
					createdAt: 100,
					lastActivityAt: 100,
					deliveredResponseCursor: 2,
					pendingInteraction: {
						id: "request",
						kind: "approval",
						createdAt: 100,
						card: { id: "card", header: "Approve", status: CardStatus.WAITING_FOR_INPUT, renderType: "text" },
					},
				},
			],
			accountingSources: { "child:legacy": { inputTokens: 12, cost: 0 } },
			accounting: { inputTokens: 12, cost: 0 },
		}
		await fs.writeFile(path.join(getTaskDirectoryPath(GOAL_ID), "goal.json"), `${JSON.stringify(legacy, null, 4)}\n`)
		for (const id of [GOAL_ID, CHILD_ID]) {
			const directory = await ensureTaskDirectoryExists(id)
			// Reading via the normal transcript helper would rename this legacy filename.
			await fs.writeFile(path.join(directory, "claude_messages.json"), messages(id))
			await fs.writeFile(path.join(directory, "api_conversation_history.json"), "[]\n")
			await fs.mkdir(path.join(directory, "context"))
			await fs.writeFile(path.join(directory, "context", "original.bin"), Buffer.from([0, 255, 1, 10]))
		}
		return createGoalHistoryItem(current, "Legacy objective", "/workspace")
	}

	async function legacyFiles(): Promise<Record<string, Buffer>> {
		const files: Record<string, Buffer> = {}
		for (const id of [GOAL_ID, CHILD_ID]) {
			const directory = getTaskDirectoryPath(id)
			for (const name of await fs.readdir(directory, { recursive: true })) {
				const filePath = path.join(directory, name)
				if ((await fs.stat(filePath)).isFile()) files[`${id}/${name}`] = await fs.readFile(filePath)
			}
		}
		return files
	}

	it("creates and round-trips only version-2 Goals with normal current-format mutation and recovery", async () => {
		const record = await store.create(GOAL_ID, "conversation", "New objective")
		assert.equal(record.version, 2)
		assert.deepEqual(await store.read(GOAL_ID), record)
		record.objective.markdown = "Detached result"
		assert.equal((await store.read(GOAL_ID)).objective.markdown, "New objective")
		await store.update(GOAL_ID, (goal, now) => {
			goal.objective = { markdown: "Revised objective", revision: 2, updatedAt: now }
		})
		await store.transition(GOAL_ID, { status: "working" })
		const recovered = await store.recoverInterruptedExecution(GOAL_ID)
		assert.equal(recovered.status, "paused")
		assert.equal(recovered.version, 2)
		assert.equal(recovered.objective.revision, 2)
		assert.equal(recovered.objective.markdown, "Revised objective")
		assert.deepEqual(await store.list(), [JSON.parse(JSON.stringify(recovered))])
	})

	it("rejects all legacy execution reads and writes before callbacks, preserving every source byte", async () => {
		await legacyGoal()
		const before = await legacyFiles()
		const mutate = sinon.stub()
		for (const operation of [
			() => store.read(GOAL_ID),
			() => store.update(GOAL_ID, mutate),
			() => store.transition(GOAL_ID, { status: "working" }, mutate),
			() => store.recoverInterruptedExecution(GOAL_ID),
		])
			await assert.rejects(operation(), LEGACY_ERROR)
		sinon.assert.notCalled(mutate)
		assert.deepEqual(await store.list(), [])
		assert.deepEqual(await store.scanRecords(), { records: [], ownedDirectoryIds: [GOAL_ID, CHILD_ID], failures: [] })
		assert.deepEqual(await store.readOwnedDirectoryIds(GOAL_ID), [GOAL_ID, CHILD_ID])
		assert.deepEqual(await legacyFiles(), before)
	})

	it("startup, selection, resumption and control reject legacy Goals without initializing or clearing a runtime", async () => {
		const item = await legacyGoal()
		const before = await legacyFiles()
		const clear = sinon.stub().resolves()
		const initialize = sinon.stub().resolves()
		const update = sinon.stub().resolves()
		const controller = new GoalController({
			controller: { ensureWorkspaceManager: initialize } as unknown as Controller,
			stateManager: { getGlobalStateKey: () => [item] } as unknown as StateManager,
			getStandaloneTask: () => undefined,
			clearStandaloneTask: clear,
			updateGoalHistory: update,
			postState: async () => {},
		})
		await controller.waitForStartupReconciliation()
		for (const operation of [
			() => controller.select(GOAL_ID),
			() => controller.resume(GOAL_ID),
			() => controller.inspect(GOAL_ID),
			() => controller.stop(GOAL_ID),
		])
			await assert.rejects(operation(), LEGACY_ERROR)
		assert.equal(controller.selectedGoalId, undefined)
		sinon.assert.notCalled(clear)
		sinon.assert.notCalled(initialize)
		sinon.assert.notCalled(update)
		assert.deepEqual(await legacyFiles(), before)
	})

	it("repair and direct reconstruction never promote legacy roots or timestamp children or migrate their transcripts", async () => {
		await legacyGoal()
		const before = await legacyFiles()
		await fs.writeFile(path.join(await ensureTaskDirectoryExists(OTHER_ID), "ui_messages.json"), messages(OTHER_ID))
		let history: RunHistoryItem[] = []
		const stateManager = {
			getGlobalStateKey: () => history,
			insertMissingTaskHistoryItems: (items: RunHistoryItem[]) => {
				history = [...history, ...items]
			},
			flushPendingState: async () => {},
		} as unknown as StateManager
		assert.deepEqual(await repairMissingTaskHistory(stateManager), {
			status: "completed",
			recovered: 1,
			skipped: 0,
			errors: 0,
		})
		assert.deepEqual(
			history.map(({ id }) => id),
			[OTHER_ID],
		)
		assert.equal(await reconstructTaskHistoryItem(GOAL_ID), null)
		assert.equal(await reconstructTaskHistoryItem(CHILD_ID), null)
		const result = await reconstructTaskHistory(false)
		assert.equal(result?.reconstructedTasks, 1)
		assert.deepEqual(
			(await readTaskHistoryFromState()).map(({ id }) => id),
			[OTHER_ID],
		)
		await fs.writeFile(await getTaskHistoryStateFilePath(), "{invalid-index")
		assert.deepEqual(
			(await readTaskHistoryFromState()).map(({ id }) => id),
			[OTHER_ID],
		)
		assert.deepEqual(await legacyFiles(), before)
	})

	it("does not reclassify a legacy-only inventory as ordinary Tasks", async () => {
		await legacyGoal()
		const before = await legacyFiles()
		assert.deepEqual(await reconstructTaskHistory(false), {
			totalTasks: 0,
			reconstructedTasks: 0,
			skippedTasks: 0,
			errors: [],
		})
		assert.deepEqual(await legacyFiles(), before)
	})

	it("prompt history uses cached public legacy summaries without reading old files or exposing an indexed private child", async () => {
		const goal = await legacyGoal()
		const before = await legacyFiles()
		const child = {
			id: CHILD_ID,
			ts: 100,
			task: "Private assignment",
			cwdOnTaskInitialization: "/workspace",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const history = new TaskHistoryController({ getGlobalStateKey: () => [goal, child] } as unknown as StateManager)
		assert.deepEqual(await history.getPromptHistory("/workspace"), [{ text: "Legacy objective", ts: goal.ts }])
		await assert.rejects(history.getTaskWithId(CHILD_ID), /belongs to a Goal/)
		assert.deepEqual(await legacyFiles(), before)
	})

	it("explicit legacy deletion acquires every private child lock before removing any source files", async () => {
		const goal = await legacyGoal()
		const before = await legacyFiles()
		const releaseChild = await acquireTaskLock(getTaskDirectoryPath(CHILD_ID))
		try {
			await assert.rejects(deleteRunStorage(goal), /another Dirac instance/)
			assert.deepEqual(await legacyFiles(), before)
			const releaseRoot = await acquireTaskLock(getTaskDirectoryPath(GOAL_ID))
			await releaseRoot()
		} finally {
			await releaseChild()
		}
		await deleteRunStorage(goal)
		for (const id of [GOAL_ID, CHILD_ID]) await assert.rejects(fs.stat(getTaskDirectoryPath(id)), { code: "ENOENT" })
	})

	it("new-format contained handles are deleted with their root, never treated as top-level directory IDs", async () => {
		const record = await store.create(GOAL_ID, "conversation", "New objective")
		const taskletId = createTaskletId()
		const directory = await ensureTaskDirectoryExists({ kind: "tasklet", rootTaskId: GOAL_ID, taskletId })
		await fs.writeFile(path.join(directory, "ui_messages.json"), messages(taskletId))
		const persisted = { ...record, children: [{ id: taskletId }] }
		await fs.writeFile(path.join(getTaskDirectoryPath(GOAL_ID), "goal.json"), JSON.stringify(persisted))
		assert.deepEqual(await store.readOwnedDirectoryIds(GOAL_ID), [GOAL_ID])
		await deleteRunStorage(createGoalHistoryItem(record, "New objective"))
		await assert.rejects(fs.stat(directory), { code: "ENOENT" })
	})

	it("unsafe historical ownership cannot escape storage or trigger partial deletion", async () => {
		const goal = await legacyGoal()
		const filePath = path.join(getTaskDirectoryPath(GOAL_ID), "goal.json")
		for (const id of ["../outside", "tasklet_invalid", "..", "bad\\path"]) {
			await fs.writeFile(filePath, JSON.stringify({ version: 1, children: [{ id }] }))
			await assert.rejects(store.readOwnedDirectoryIds(GOAL_ID), /Invalid task directory identity/)
			await assert.rejects(deleteRunStorage(goal), /Invalid task directory identity/)
			assert.equal((await fs.stat(filePath)).isFile(), true)
		}
	})

	it("keeps safe private siblings excluded when a legacy record also contains an unsafe child reference", async () => {
		const goal = await legacyGoal()
		const filePath = path.join(getTaskDirectoryPath(GOAL_ID), "goal.json")
		const legacy = JSON.parse(await fs.readFile(filePath, "utf8"))
		legacy.children.push({ id: "../outside" })
		await fs.writeFile(filePath, JSON.stringify(legacy))
		const before = await legacyFiles()
		const inventory = await store.scanRecords()
		assert.deepEqual(inventory.ownedDirectoryIds, [GOAL_ID, CHILD_ID])
		assert.equal(inventory.failures.length, 1)
		const insert = sinon.stub()
		const stateManager = { getGlobalStateKey: () => [], insertMissingTaskHistoryItems: insert } as unknown as StateManager
		assert.deepEqual(await repairMissingTaskHistory(stateManager), {
			status: "completed",
			recovered: 0,
			skipped: 0,
			errors: 1,
		})
		sinon.assert.notCalled(insert)
		assert.equal(await reconstructTaskHistoryItem(CHILD_ID), null)
		assert.equal((await reconstructTaskHistory(false))?.reconstructedTasks, 0)
		const child = {
			id: CHILD_ID,
			ts: 100,
			task: "Private assignment",
			cwdOnTaskInitialization: "/workspace",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const history = new TaskHistoryController({ getGlobalStateKey: () => [goal, child] } as unknown as StateManager)
		assert.deepEqual(await history.getPromptHistory("/workspace"), [{ text: goal.task, ts: goal.ts }])
		await assert.rejects(deleteRunStorage(goal), /Invalid task directory identity/)
		assert.deepEqual(await legacyFiles(), before)
	})

	it("actual indexed-history selection rejects private children before disturbing the current Goal or standalone runtime", async () => {
		expectLoggerErrors()
		await legacyGoal()
		const before = await legacyFiles()
		const child = { id: CHILD_ID, ts: 100, task: "Private assignment", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		const stateManager = { getGlobalStateKey: () => [child] } as unknown as StateManager
		const pause = sinon.stub().resolves()
		const initialize = sinon.stub().resolves()
		const controller = {
			stateManager,
			taskHistoryController: new TaskHistoryController(stateManager),
			goalController: { selectedGoalId: "current-goal", pauseAndDeselect: pause },
			taskController: { initTask: initialize },
			initTask: Controller.prototype.initTask,
		} as unknown as Controller
		await assert.rejects(showTaskWithId(controller, { value: CHILD_ID }), /belongs to a Goal/)
		sinon.assert.notCalled(pause)
		sinon.assert.notCalled(initialize)
		assert.deepEqual(await legacyFiles(), before)
	})

	it("rejecting legacy Goal selection does not cancel another running coordinator or clear its foreground Task", async () => {
		const item = await legacyGoal()
		const clear = sinon.stub().resolves()
		const cancel = sinon.stub().resolves()
		const controller = new GoalController({
			controller: {} as Controller,
			stateManager: { getGlobalStateKey: () => [item] } as unknown as StateManager,
			getStandaloneTask: () => undefined,
			clearStandaloneTask: clear,
			updateGoalHistory: async () => [item],
			postState: async () => {},
		})
		controller["selectedLoop"] = {
			goalId: "current-goal",
			hasRunningCoordinator: true,
			cancelCurrentExecution: cancel,
		} as never
		await assert.rejects(controller.select(GOAL_ID), LEGACY_ERROR)
		assert.equal(controller.selectedGoalId, "current-goal")
		sinon.assert.notCalled(cancel)
		sinon.assert.notCalled(clear)
	})

	it("already-superseded schemaVersion records also reject execution and remain ownership-only until explicit deletion", async () => {
		const goal = await legacyGoal()
		const filePath = path.join(getTaskDirectoryPath(GOAL_ID), "goal.json")
		await fs.writeFile(
			filePath,
			JSON.stringify({ schemaVersion: 5, children: [{ id: CHILD_ID }], definition: { contract: "Old objective" } }),
		)
		const before = await legacyFiles()
		await assert.rejects(store.read(GOAL_ID), LEGACY_ERROR)
		await assert.rejects(store.recoverInterruptedExecution(GOAL_ID), LEGACY_ERROR)
		assert.equal(await reconstructTaskHistoryItem(CHILD_ID), null)
		assert.deepEqual(await store.readOwnedDirectoryIds(GOAL_ID), [GOAL_ID, CHILD_ID])
		assert.deepEqual(await store.list(), [])
		assert.deepEqual(await legacyFiles(), before)
		await deleteRunStorage(goal)
		await assert.rejects(fs.stat(getTaskDirectoryPath(CHILD_ID)), { code: "ENOENT" })
	})

	it("malformed current records and unreadable JSON remain excluded and reported, not mistaken for legacy records", async () => {
		await store.create(GOAL_ID, "conversation", "New objective")
		await fs.writeFile(
			path.join(getTaskDirectoryPath(GOAL_ID), "goal.json"),
			JSON.stringify({ version: 2, children: [{ id: CHILD_ID }] }),
		)
		await fs.writeFile(path.join(await ensureTaskDirectoryExists(OTHER_ID), "goal.json"), "{invalid-json")
		const report = await store.scanRecords()
		assert.deepEqual(report.records, [])
		assert.deepEqual(report.ownedDirectoryIds.sort(), [GOAL_ID, CHILD_ID, OTHER_ID])
		assert.deepEqual(report.failures.map(({ goalId }) => goalId).sort(), [GOAL_ID, OTHER_ID])
		await assert.rejects(store.list(), AggregateError)
		assert.equal(await reconstructTaskHistoryItem(GOAL_ID), null)
		assert.equal(await reconstructTaskHistoryItem(CHILD_ID), null)
	})
})

function messages(id: string): string {
	return JSON.stringify([
		{ id: `${id}-message`, ts: 100, content: { type: "markdown", role: "user", content: `Private transcript ${id}` } },
	])
}
