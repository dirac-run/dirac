import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { Task } from "../index"
import { TaskState } from "../TaskState"
import { SteeringDeliveryState } from "../steering"

function taskWithPersistenceOwner() {
	const task = Object.create(Task.prototype) as any
	task.messageStateHandler = {
		flushPendingWrites: sinon.stub().resolves(),
		retirePersistence: sinon.stub().resolves(),
	}
	task.releaseTaskLock = sinon.stub().resolves()
	task.lifecycleManager = { finalizeTaskRun: sinon.stub().resolves() }
	task.taskState = { settleRunOutcome: (outcome: unknown) => outcome }
	task.withStateLock = async (operation: () => unknown) => operation()
	return task
}

describe("Task persistence ownership", () => {
	it("flushes and retires the writer before releasing ownership exactly once", async () => {
		const task = taskWithPersistenceOwner()
		await Promise.all([task.retirePersistence(), task.retirePersistence()])
		sinon.assert.calledOnce(task.messageStateHandler.flushPendingWrites)
		sinon.assert.calledOnce(task.messageStateHandler.retirePersistence)
		sinon.assert.calledOnce(task.releaseTaskLock)
		sinon.assert.callOrder(
			task.messageStateHandler.flushPendingWrites,
			task.messageStateHandler.retirePersistence,
			task.releaseTaskLock,
		)
	})

	it("does not release ownership while writer retirement is still pending", async () => {
		const task = taskWithPersistenceOwner()
		let finishRetirement!: () => void
		task.messageStateHandler.retirePersistence.returns(
			new Promise<void>((resolve) => {
				finishRetirement = resolve
			}),
		)
		const retirement = task.retirePersistence()
		await Promise.resolve()
		sinon.assert.notCalled(task.releaseTaskLock)
		finishRetirement()
		await retirement
		sinon.assert.calledOnce(task.releaseTaskLock)
	})

	it("keeps completed and cancelled standalone tasks exclusively open for follow-up", async () => {
		for (const kind of ["completed", "cancelled"]) {
			const task = taskWithPersistenceOwner()
			task.executionProfile = "standalone"
			await task.settleTaskRun({ kind })
			sinon.assert.notCalled(task.releaseTaskLock)
			sinon.assert.notCalled(task.messageStateHandler.retirePersistence)
			await task.retirePersistence()
			sinon.assert.calledOnce(task.releaseTaskLock)
		}
	})

	for (const executionProfile of ["goal_child", "goal_coordinator", "goal_followup"] as const) {
		it(`retires ${executionProfile} writers and contained work when their run finishes`, async () => {
		const task = taskWithPersistenceOwner()
			task.executionProfile = executionProfile
			task.taskletHost = executionProfile === "goal_child" ? undefined : { shutdown: sinon.stub().resolves() }
		await task.settleTaskRun({ kind: "completed", response: "done", completedAt: 1 })
		sinon.assert.callOrder(task.lifecycleManager.finalizeTaskRun, task.releaseTaskLock)
		sinon.assert.calledOnce(task.messageStateHandler.retirePersistence)
		sinon.assert.calledOnce(task.releaseTaskLock)
			if (task.taskletHost) sinon.assert.callOrder(task.taskletHost.shutdown, task.releaseTaskLock)
	})

		it(`retires ${executionProfile} writers even if resource cleanup fails`, async () => {
		const task = taskWithPersistenceOwner()
			task.executionProfile = executionProfile
		task.lifecycleManager.finalizeTaskRun.rejects(new Error("cleanup failed"))
		const outcome = await task.settleTaskRun({ kind: "completed", response: "done", completedAt: 1 })
		assert.equal(outcome.kind, "failed")
		sinon.assert.calledOnce(task.releaseTaskLock)
	})
	}
	it("joins tasklet shutdown before retiring the root writer or releasing its lock", async () => {
		const task = taskWithPersistenceOwner()
		let finish!: () => void
		task.taskletHost = { shutdown: sinon.stub().returns(new Promise<void>((resolve) => { finish = resolve })) }
		const retirement = task.retirePersistence()
		await Promise.resolve()
		sinon.assert.notCalled(task.messageStateHandler.retirePersistence)
		sinon.assert.notCalled(task.releaseTaskLock)
		finish()
		await retirement
		sinon.assert.callOrder(task.taskletHost.shutdown, task.messageStateHandler.retirePersistence, task.releaseTaskLock)
	})

	it("retires the root writer but retains ownership when child shutdown fails", async () => {
		const task = taskWithPersistenceOwner()
		const error = new Error("child outcome write failed")
		task.taskletHost = { shutdown: sinon.stub().rejects(error) }
		await assert.rejects(task.retirePersistence(), (actual) => actual === error)
		sinon.assert.calledOnce(task.messageStateHandler.retirePersistence)
		sinon.assert.notCalled(task.releaseTaskLock)
		await assert.rejects(task.retirePersistence(), (actual) => actual === error)
		sinon.assert.calledOnce(task.taskletHost.shutdown)
	})

	it("attempts root abort even when tasklet shutdown fails and reports both failures", async () => {
		const task = taskWithPersistenceOwner()
		task.taskState = new TaskState()
		task.taskletHost = { shutdown: sinon.stub().rejects(new Error("child cleanup")) }
		task.lifecycleManager.abortTask = sinon.stub().rejects(new Error("root cleanup"))
		await assert.rejects(task.abortTask(), (error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors.map((entry) => entry.message), ["child cleanup", "root cleanup"])
			return true
		})
		sinon.assert.calledOnce(task.lifecycleManager.abortTask)
	})

	it("settles owned children on terminal root failure while retaining follow-up ownership", async () => {
		const task = taskWithPersistenceOwner()
		task.executionProfile = "standalone"
		task.taskletHost = { shutdown: sinon.stub().rejects(new Error("child persistence failed")) }
		const outcome = await task.settleTaskRun({ kind: "failed", error: { name: "Error", message: "provider failed" }, failedAt: 1 })
		assert.equal(outcome.kind, "failed")
		assert.equal(outcome.error.name, "AggregateError")
		assert.match(outcome.error.message, /Task termination failed/)
		sinon.assert.calledOnce(task.taskletHost.shutdown)
		sinon.assert.notCalled(task.releaseTaskLock)
	})

	it("rejects completion with active tasklet identities without joining or cancelling them", async () => {
		const task = taskWithPersistenceOwner()
		task.taskState = new TaskState()
		task.taskletHost = {
			listActive: sinon.stub().returns([{ id: "tasklet-active", title: "waiting for input" }]),
			shutdown: sinon.stub().resolves(),
		}
		const result = await task.commitAttemptCompletion("premature")
		assert.equal(result.committed, false)
		assert.match(result.error, /tasklet-active \(waiting for input\)/)
		assert.equal(task.taskState.completionCommitted, false)
		assert.equal(task.taskState.completionResponse, undefined)
		sinon.assert.notCalled(task.taskletHost.shutdown)
		task.taskletHost.listActive.returns([])
		assert.deepEqual(await task.commitAttemptCompletion("finished"), { committed: true })
		assert.equal(task.taskState.completionResponse, "finished")
	})

	it("preserves queued-steering rejection when tasklets also block completion", async () => {
		const task = taskWithPersistenceOwner()
		task.taskState = new TaskState()
		task.taskState.steeringMessages = [{ deliveryState: SteeringDeliveryState.QUEUED }]
		task.taskletHost = { listActive: sinon.stub().returns([{ id: "active", title: "work" }]) }
		const result = await task.commitAttemptCompletion("premature")
		assert.match(result.error, /queued user steering/)
		sinon.assert.notCalled(task.taskletHost.listActive)
	})
})
