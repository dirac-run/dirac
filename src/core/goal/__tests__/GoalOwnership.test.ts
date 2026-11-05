import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deleteRunStorage, deleteRunsStorage } from "@core/controller/TaskHistoryController"
import type { StateManager } from "@core/storage/StateManager"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import type { Task } from "@core/task"
import { acquireTaskLock } from "@core/task/TaskLockUtils"
import type { TaskRunOutcome } from "@core/task/TaskRunOutcome"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { createGoalHistoryItem } from "../GoalHistory"
import { GoalLoop } from "../GoalLoop"
import { GoalStore } from "../GoalStore"
import type { GoalTaskFactory } from "../GoalTaskFactory"
import * as taskLocks from "@core/task/TaskLockUtils"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

describe("Goal execution ownership", () => {
	let storagePath: string
	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "goal-ownership-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storagePath })
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	async function harness(id: string, store = new GoalStore()) {
		const record = await store.create(id, `conversation-${id}`, "Ship it")
		const history = [createGoalHistoryItem(record, "Ship it", "/workspace")]
		const outcome = deferred<TaskRunOutcome>()
		const task = {
			startTask: () => outcome.promise,
			resumeTaskFromHistory: () => outcome.promise,
			abortTask: async () => outcome.resolve({ kind: "cancelled", cancelledAt: Date.now() }),
			retirePersistence: sinon.stub().resolves(),
		} as unknown as Task
		const create = sinon.stub().resolves(task)
		const dependencies = {
			goalId: id,
			initialDisplayText: "Ship it",
			store,
			createTaskFactory: () => ({ create }) as unknown as GoalTaskFactory,
			stateManager: { getGlobalStateKey: () => history } as unknown as StateManager,
			updateHistory: async () => history,
			postState: async () => {},
		}
		const loop = new GoalLoop(dependencies)
		return { loop, store, outcome, create, history, dependencies }
	}

	it("allows independent Goals, but rejects same-Goal activation before changing state or selection", async () => {
		const first = await harness("1001")
		const second = await harness("1002")
		await first.loop.start()
		await second.loop.start()
		try {
			const before = await first.store.read("1001")
			const select = sinon.stub().resolves()
			await assert.rejects(new GoalLoop(first.dependencies).resume(select), /another Dirac instance/)
			assert.equal(select.called, false)
			assert.deepEqual(await first.store.read("1001"), before)
			await assert.rejects(first.store.delete("1001"), /another Dirac instance/)
			await assert.rejects(first.store.create("1001", "collision", "Other work"), /another Dirac instance/)
			assert.equal(second.loop.hasRunningCoordinator, true)
		} finally {
			await Promise.all([first.loop.pause(), second.loop.pause()])
		}
	})

	it("keeps follow-up ownership even though durable lifecycle status is paused", async () => {
		const h = await harness("1003")
		await h.loop.sendMessage("Explain the result")
		try {
			const contender = new GoalLoop(h.dependencies)
			await assert.rejects(contender.sendMessage("Another message"), /another Dirac instance/)
			await assert.rejects(contender.stop(), /another Dirac instance/)
			await assert.rejects(deleteRunStorage(h.history[0]), /another Dirac instance/)
			assert.equal((await h.store.read("1003")).status, "paused")
		} finally {
			await h.loop.cancelCurrentExecution()
		}
	})

	for (const execution of ["goal", "followup"] as const) {
		it(`retains ${execution} ownership when contained persistence cannot retire`, async () => {
			expectLoggerErrors()
			const h = await harness(`unsafe-${execution}`)
			const acquisition = sinon.spy(taskLocks, "acquireTaskLock")
			if (execution === "goal") await h.loop.start()
			else await h.loop.sendMessage("Explicit follow-up")
			// Test teardown alone may release this deliberately failed owner's real lock.
			const release = await acquisition.firstCall.returnValue
			try {
				const task = await h.create.firstCall.returnValue
				const retirement = task.retirePersistence as sinon.SinonStub
				retirement.rejects(new Error("child outcome write failed"))
				const settlement = h.loop["runtime"]!.settlement!
				const rejected = assert.rejects(settlement, /child outcome write failed/)
				h.outcome.resolve({ kind: "failed", error: { name: "Error", message: "Task termination failed" }, failedAt: Date.now() })
				await rejected
				assert.equal(h.loop.hasRunningCoordinator, true)
				await assert.rejects(acquireTaskLock(getTaskDirectoryPath(h.loop.goalId)), /another Dirac instance/)
				await assert.rejects(new GoalLoop(h.dependencies).sendMessage("Cannot reopen"), /another Dirac instance/)
				await assert.rejects(deleteRunStorage(h.history[0]), /another Dirac instance/)
				if (execution === "followup") assert.equal((await h.store.read(h.loop.goalId)).status, "paused")
			} finally { await release() }
		})
	}

	it("blocks a naturally failed coordinator and releases ownership after successful retirement", async () => {
		const h = await harness("natural-failure")
		await h.loop.start()
		const settlement = h.loop["runtime"]!.settlement!
		h.outcome.resolve({ kind: "failed", error: { name: "Error", message: "provider failed" }, failedAt: Date.now() })
		await settlement
		assert.equal((await h.store.read(h.loop.goalId)).status, "blocked")
		assert.match((await h.store.read(h.loop.goalId)).statusReason!, /provider failed/)
		assert.equal(h.loop.hasRunningCoordinator, false)
		const release = await acquireTaskLock(getTaskDirectoryPath(h.loop.goalId))
		await release()
	})

	it("holds ownership through final history persistence", async () => {
		const h = await harness("1004")
		const writing = deferred<void>()
		const finishWrite = deferred<void>()
		await h.loop.start()
		h.dependencies.updateHistory = async () => {
			writing.resolve()
			await finishWrite.promise
			return h.history
		}
		const settlement = h.loop["runtime"]!.settlement!
		h.outcome.resolve({ kind: "completed", response: "Done", completedAt: Date.now() })
		await writing.promise
		try {
			await assert.rejects(acquireTaskLock(getTaskDirectoryPath("1004")), /another Dirac instance/)
		} finally {
			finishWrite.resolve()
			await settlement
		}
		const release = await acquireTaskLock(getTaskDirectoryPath("1004"))
		await release()
		assert.equal(h.loop.hasRunningCoordinator, false)
	})

	it("releases a retired runtime when its final Goal metadata transition fails", async () => {
		expectLoggerErrors()
		const h = await harness("1005")
		await h.loop.start()
		const settlement = h.loop["runtime"]!.settlement!
		sinon.stub(h.store, "transition").rejects(new Error("disk failure"))
		const rejected = assert.rejects(settlement, /disk failure/)
		h.outcome.resolve({ kind: "completed", response: "Done", completedAt: Date.now() })
		await rejected
		assert.equal(h.loop.hasRunningCoordinator, false)
		const release = await acquireTaskLock(getTaskDirectoryPath("1005"))
		await release()
	})

	it("does not retain an empty retired host for an unrelated Goal-record cleanup write", async () => {
		const h = await harness("empty-host")
		await h.loop.start()
		const settlement = h.loop["runtime"]!.settlement!
		const update = sinon.stub(h.store, "update").rejects(new Error("unnecessary cleanup disk failure"))
		h.outcome.resolve({ kind: "completed", response: "Done", completedAt: Date.now() })
		await settlement
		sinon.assert.notCalled(update)
		assert.equal(h.loop.hasRunningCoordinator, false)
		const release = await acquireTaskLock(getTaskDirectoryPath(h.loop.goalId))
		await release()
	})

	it("releases ownership and records a blocked Goal when coordinator construction fails", async () => {
		const h = await harness("1006")
		h.create.rejects(new Error("construction failed"))
		await assert.rejects(h.loop.start(), /construction failed/)
		assert.equal(h.loop.hasRunningCoordinator, false)
		assert.equal((await h.store.read("1006")).status, "blocked")
		const release = await acquireTaskLock(getTaskDirectoryPath("1006"))
		await release()
	})

	it("recovers only an acquired abandoned Goal, leaving unrelated active records untouched", async () => {
		const h = await harness("1007")
		await h.store.transition("1007", { status: "working" })
		await h.store.create("other", "conversation-other", "Other work")
		const other = await h.store.transition("other", { status: "working" })
		await h.loop.resume()
		try {
			assert.equal(h.create.firstCall.args[0].executionProfile, "goal_coordinator")
			assert.deepEqual(await h.store.read("other"), JSON.parse(JSON.stringify(other)))
		} finally {
			await h.loop.pause()
		}
	})

	it("refuses bulk deletion before removing any files when one target is owned", async () => {
		const first = await harness("1008")
		const second = await harness("1009")
		await second.loop.start()
		try {
			await assert.rejects(deleteRunsStorage([...first.history, ...second.history]), /another Dirac instance/)
			await first.store.read("1008")
			await second.store.read("1009")
		} finally {
			await second.loop.pause()
		}
	})

	it("does not reconcile another process's owned Goal and recovers a stale lock after its exit", async () => {
		const h = await harness("1010")
		const working = await h.store.transition("1010", { status: "working" })
		const directory = getTaskDirectoryPath("1010")
		const child = spawn(
			process.execPath,
			[
				"-e",
				`
			require('proper-lockfile').lock(process.argv[1], {realpath:false, stale:30000, update:5000})
				.then(() => { process.stdout.write('ready'); setInterval(() => {}, 1000) })
				.catch(error => { console.error(error); process.exit(1) })
		`,
				directory,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		)
		try {
			await once(child.stdout!, "data")
			await h.store.scanRecords()
			assert.deepEqual(await h.store.read("1010"), JSON.parse(JSON.stringify(working)))
			await assert.rejects(h.loop.resume(), /another Dirac instance/)
		} finally {
			const exited = once(child, "exit")
			child.kill("SIGKILL")
			await exited
		}
		// Emulate expiration without making the test wait for the 30-second stale interval.
		const expired = new Date(Date.now() - 60_000)
		await fs.utimes(`${directory}.lock`, expired, expired)
		await h.loop.resume()
		await h.loop.pause()
	})
})
