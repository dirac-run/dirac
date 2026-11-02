import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { GlobalFileNames } from "@core/storage/fileNames"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import * as storage from "@core/storage/taskStorage"
import { TaskStatus } from "@shared/ExtensionMessage"
import * as taskModule from "../index"
import { TaskletHost, type TaskletTaskOptions } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/** Controlled executions, real addressed/atomic record storage. Real Task coverage is in TaskletExecution.test.ts. */
describe("TaskletHost asynchronous ownership", () => {
	let sandbox: sinon.SinonSandbox
	let directory: string
	let host: TaskletHost
	let constructed: sinon.SinonStub
	let children: ReturnType<typeof controlledTask>[]
	const completed: TaskRunOutcome = { kind: "completed", response: "full result", completedAt: 123 }

	function controlledTask() {
		const outcome = deferred<TaskRunOutcome>()
		const task = {
			stateView: { status: TaskStatus.WAITING_FOR_API },
			startTask: sandbox.stub().returns(outcome.promise),
			abortTask: sandbox.stub().callsFake(async () => {
				outcome.resolve({ kind: "interrupted", reason: "test", interruptedAt: 124 })
			}),
			retirePersistence: sandbox.stub().resolves(),
			enqueueSteeringMessage: sandbox.stub().resolves("steering-id"),
			messageStateHandler: {
				getApiConversationHistory: () => [{ role: "assistant", content: [{ type: "text", text: "live detail" }] }],
				getDiracMessages: () => [],
			},
		}
		return { task, outcome }
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-host-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		children = []
		constructed = sandbox.stub(taskModule, "Task").callsFake((() => {
			const child = controlledTask()
			children.push(child)
			return child.task
		}) as any)
		host = new TaskletHost(
			{ taskId: "root", executionProfile: "standalone" },
			{} as TaskletTaskOptions,
			constructed as unknown as typeof taskModule.Task,
		)
	})

	afterEach(async () => {
		for (const record of host.list()) {
			try {
				await host.interrupt(record.id)
			} catch {
				/* Failure-path assertions own these expected rejections. */
			}
		}
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function saved(id: string) {
		return JSON.parse(
			await fs.readFile(
				path.join(
					getTaskDirectoryPath({ kind: "tasklet", rootTaskId: "root", taskletId: id }),
					GlobalFileNames.taskletRecord,
				),
				"utf8",
			),
		) as storage.TaskletRecord
	}

	it("accepts two unfinished children durably, without joining, and scopes detached inspection snapshots", async () => {
		const [first, second] = await Promise.all([
			host.start({ title: "first", prompt: "first assignment" }),
			host.start({ title: "second", prompt: "second assignment" }),
		])
		assert.notEqual(first.id, second.id)
		assert.equal(first.outcome, undefined)
		assert.deepEqual(await saved(first.id), first)
		assert.deepEqual(await saved(second.id), second)
		assert.equal(host.list().length, 2)
		const snapshot = host.inspect(first.id)
		snapshot.prompt = "cannot mutate owner"
		assert.equal(host.inspect(first.id).prompt, "first assignment")
		const other = new TaskletHost({ taskId: "other", executionProfile: "standalone" }, {} as TaskletTaskOptions)
		assert.throws(() => other.inspect(first.id), /does not belong/)
		await assert.rejects(other.steer(first.id, "wrong root"), /does not belong/)
		await assert.rejects(other.interrupt(first.id), /does not belong/)
		await assert.rejects(other.readTranscript(first.id), /does not belong/)
		assert.deepEqual(await fs.readdir(path.join(directory, "tasks")), ["root"])
		const params = constructed.firstCall.args[0] as taskModule.TaskParams
		assert.equal(params.executionProfile, "tasklet")
		assert.equal(params.releaseTaskLock, undefined)
		assert.equal(params.tasklet?.storageAddress.rootTaskId, "root")
		await assert.rejects(params.postStateToWebview(), /foreground/)
	})

	it("acknowledges steering acceptance and reads live transcripts without waiting for a result", async () => {
		const record = await host.start({ title: "work", prompt: "assignment" })
		assert.deepEqual(await host.steer(record.id, "change focus"), { id: record.id, messageId: "steering-id", accepted: true })
		sinon.assert.calledOnceWithExactly(children[0].task.enqueueSteeringMessage, "change focus")
		assert.equal(host.inspect(record.id).outcome, undefined)
		const transcript = await host.readTranscript(record.id)
		assert.match(JSON.stringify(transcript), /live detail/)
		transcript.conversation.length = 0
		assert.equal((await host.readTranscript(record.id)).conversation.length, 1)
		children[0].task.enqueueSteeringMessage.rejects(new Error("Task cannot accept steering while idle"))
		await assert.rejects(host.steer(record.id, "too early"), /cannot accept/)
	})

	it("interrupts only the selected child and preserves its identity and durable artifacts", async () => {
		const first = await host.start({ title: "first", prompt: "first" })
		const second = await host.start({ title: "second", prompt: "second" })
		const stopped = await host.interrupt(first.id, "stop first")
		assert.equal(stopped.id, first.id)
		assert.equal(stopped.conversationUlid, first.conversationUlid)
		assert.equal(stopped.outcome?.kind, "interrupted")
		assert.equal(stopped.outcomePersisted, true)
		assert.deepEqual((await saved(first.id)).outcome, stopped.outcome)
		sinon.assert.notCalled(children[1].task.abortTask)
		assert.equal(host.inspect(second.id).outcome, undefined)
		await assert.rejects(host.steer(first.id, "late"), /not running/)
		assert.deepEqual(await host.interrupt(first.id), stopped)
	})

	it("does not mistake a completion presentation for the committed run outcome", async () => {
		const record = await host.start({ title: "work", prompt: "work" })
		children[0].task.stateView.status = TaskStatus.COMPLETED
		assert.equal(host.inspect(record.id).outcome, undefined)
		children[0].outcome.resolve({ kind: "failed", failedAt: 123, error: { name: "Error", message: "finalization failed" } })
		const result = await host.interrupt(record.id)
		assert.equal(result.outcome?.kind, "failed")
		assert.equal((await saved(record.id)).outcome?.kind, "failed")
	})

	it("rejects initial persistence failure without constructing or publishing a child", async () => {
		sandbox.stub(storage, "saveTaskletRecord").rejects(new Error("disk unavailable"))
		await assert.rejects(host.start({ title: "work", prompt: "work" }), /disk unavailable/)
		sinon.assert.notCalled(constructed)
		assert.deepEqual(host.list(), [])
	})

	it("records constructor failures with a stable inspectable handle", async () => {
		constructed.throws(new Error("construction failed"))
		const record = await host.start({ title: "work", prompt: "work" })
		assert.equal(record.outcome?.kind, "failed")
		assert.match(JSON.stringify(record.outcome), /construction failed/)
		assert.deepEqual(await saved(record.id), record)
		assert.equal(host.inspect(record.id).outcomePersisted, true)
	})

	it("retires a constructed execution if start rejects unexpectedly", async () => {
		const record = await host.start({ title: "work", prompt: "work" })
		children[0].outcome.reject(new Error("start rejected"))
		const result = await host.interrupt(record.id)
		assert.equal(result.outcome?.kind, "failed")
		assert.match(JSON.stringify(result.outcome), /start rejected/)
		sinon.assert.called(children[0].task.retirePersistence)
	})

	it("waits for rejected-start cancellation before retiring persistence, even when cancellation fails", async () => {
		const record = await host.start({ title: "work", prompt: "work" })
		const abort = deferred<void>()
		const abortEntered = deferred<void>()
		children[0].task.abortTask.callsFake(() => {
			abortEntered.resolve()
			return abort.promise
		})
		children[0].outcome.reject(new Error("start rejected"))
		await abortEntered.promise
		sinon.assert.notCalled(children[0].task.retirePersistence)
		abort.reject(new Error("abort failed"))
		await new Promise<void>((resolve) => setImmediate(resolve))
		// The run owns this failure; observe its persistence without issuing another cancellation.
		const deadline = Date.now() + 1_000
		while (!host.inspect(record.id).outcomePersisted) {
			assert.ok(Date.now() < deadline)
			await new Promise<void>((resolve) => setImmediate(resolve))
		}
		sinon.assert.calledOnce(children[0].task.retirePersistence)
		assert.equal(host.inspect(record.id).outcome?.kind, "failed")
		assert.match(JSON.stringify(await host.readTranscript(record.id)), /live detail/)
	})

	it("retains outcome-write failures for inspection and propagates them through interruption", async () => {
		expectLoggerErrors()
		const record = await host.start({ title: "work", prompt: "work" })
		sandbox.stub(storage, "saveTaskletRecord").rejects(new Error("outcome disk failure"))
		children[0].outcome.resolve(completed)
		await assert.rejects(host.interrupt(record.id), /interruption failed/)
		const result = host.inspect(record.id)
		assert.deepEqual(result.outcome, completed)
		assert.equal(result.outcomePersisted, false)
		assert.match(result.settlementError!.message, /outcome disk failure/)
		assert.equal((await saved(record.id)).outcome, undefined)
	})

	it("joins settlement even when cancellation rejects, without losing the committed outcome", async () => {
		const record = await host.start({ title: "work", prompt: "work" })
		children[0].task.abortTask.rejects(new Error("abort failed"))
		let settled = false
		const interruption = host.interrupt(record.id).finally(() => {
			settled = true
		})
		const rejection = assert.rejects(interruption, /interruption failed/)
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(settled, false)
		children[0].outcome.resolve(completed)
		await rejection
		assert.deepEqual((await saved(record.id)).outcome, completed)
	})

	it("lists running, input-waiting and acceptance-pending children without joining or cancelling them", async () => {
		const running = await host.start({ title: "running", prompt: "work" })
		const waiting = await host.start({ title: "waiting", prompt: "ask" })
		children[1].task.stateView.status = TaskStatus.AWAITING_USER_INPUT
		const releaseAcceptance = deferred<void>()
		const originalSave = storage.saveTaskletRecord
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
			if (!record.outcome) await releaseAcceptance.promise
			return originalSave(record)
		})
		const starting = host.start({ title: "starting", prompt: "later" })
		try {
			const active = host.listActive()
			assert.equal(active.length, 3)
			assert.ok(active.some(({ id, title }) => id === running.id && title === "running"))
			assert.ok(active.some(({ id, title }) => id === waiting.id && title === "waiting"))
			assert.ok(active.some(({ title }) => title === "starting"))
			assert.equal(host.list().length, 2)
			active[0].title = "changed snapshot"
			assert.ok(host.listActive().some(({ title }) => title === "running"))
			for (const child of children) sinon.assert.notCalled(child.task.abortTask)
		} finally {
			releaseAcceptance.resolve()
			await starting
		}
		await host.interrupt(running.id)
		assert.equal(host.listActive().some(({ id }) => id === running.id), false)
		assert.equal(host.listActive().length, 2)
	})

	it("joins an in-flight acceptance write at shutdown without constructing late work", async () => {
		const releaseAcceptance = deferred<void>()
		const originalSave = storage.saveTaskletRecord
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
			if (!record.outcome) await releaseAcceptance.promise
			return originalSave(record)
		})
		const starting = host.start({ title: "starting", prompt: "work" })
		let settled = false
		const shutdown = host.shutdown().then(() => { settled = true })
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			assert.equal(settled, false)
			sinon.assert.notCalled(constructed)
			await assert.rejects(host.start({ title: "too late", prompt: "work" }), /shutting down/)
		} finally {
			releaseAcceptance.resolve()
		}
		const record = await starting
		await shutdown
		sinon.assert.notCalled(constructed)
		assert.equal(record.outcome?.kind, "interrupted")
		assert.deepEqual(await saved(record.id), record)
		assert.equal(host.inspect(record.id).outcomePersisted, true)
		assert.deepEqual(host.listActive(), [])
	})

	it("does not settle shutdown before a completed child's final record write finishes", async () => {
		const record = await host.start({ title: "finishing", prompt: "work" })
		const writeEntered = deferred<void>()
		const releaseWrite = deferred<void>()
		const originalSave = storage.saveTaskletRecord
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (value) => {
			writeEntered.resolve()
			await releaseWrite.promise
			return originalSave(value)
		})
		children[0].outcome.resolve(completed)
		await writeEntered.promise
		let settled = false
		const shutdown = host.shutdown().then(() => { settled = true })
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			assert.equal(settled, false)
			assert.equal(host.inspect(record.id).outcomePersisted, false)
			assert.equal((await saved(record.id)).outcome, undefined)
			sinon.assert.notCalled(children[0].task.abortTask)
		} finally {
			releaseWrite.resolve()
			await shutdown
		}
		assert.deepEqual((await saved(record.id)).outcome, completed)
		assert.equal(host.inspect(record.id).outcomePersisted, true)
	})

	it("shares one shutdown promise, interrupts every live child once and permanently closes admission", async () => {
		const first = await host.start({ title: "first", prompt: "work" })
		const second = await host.start({ title: "second", prompt: "work" })
		children[1].task.stateView.status = TaskStatus.AWAITING_USER_INPUT
		const shutdown = host.shutdown()
		assert.equal(host.shutdown(), shutdown)
		await shutdown
		assert.equal(host.shutdown(), shutdown)
		await assert.rejects(host.start({ title: "late", prompt: "work" }), /shutting down/)
		sinon.assert.calledTwice(constructed)
		for (const child of children) {
			sinon.assert.calledOnceWithExactly(child.task.abortTask, { kind: "interrupted", reason: "Root Task closed" })
		}
		for (const record of [first, second]) {
			assert.equal((await saved(record.id)).outcome?.kind, "interrupted")
			assert.equal(host.inspect(record.id).outcomePersisted, true)
		}
		assert.deepEqual(host.listActive(), [])
	})

	it("reports cancellation failure only after the failed child's run and sibling cleanup settle", async () => {
		const first = await host.start({ title: "first", prompt: "work" })
		const second = await host.start({ title: "second", prompt: "work" })
		children[0].task.abortTask.rejects(new Error("cancel failed"))
		let settled = false
		const shutdown = host.shutdown()
		const rejection = assert.rejects(shutdown, /Tasklet shutdown failed/).then(() => { settled = true })
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			assert.equal(settled, false)
			sinon.assert.calledOnce(children[1].task.abortTask)
		} finally {
			children[0].outcome.resolve(completed)
			await rejection
		}
		assert.equal(host.shutdown(), shutdown)
		assert.deepEqual((await saved(first.id)).outcome, completed)
		assert.equal((await saved(second.id)).outcome?.kind, "interrupted")
		assert.equal(host.inspect(second.id).outcomePersisted, true)
	})

	it("surfaces outcome-write failure without skipping sibling shutdown and persistence", async () => {
		expectLoggerErrors()
		const first = await host.start({ title: "first", prompt: "work" })
		const second = await host.start({ title: "second", prompt: "work" })
		const originalSave = storage.saveTaskletRecord
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (record) => {
			if (record.id === first.id) throw new Error("final record unavailable")
			return originalSave(record)
		})
		await assert.rejects(host.shutdown(), /Tasklet shutdown failed/)
		for (const child of children) sinon.assert.calledOnce(child.task.abortTask)
		assert.equal(host.inspect(first.id).outcomePersisted, false)
		assert.match(host.inspect(first.id).settlementError!.message, /final record unavailable/)
		assert.equal((await saved(second.id)).outcome?.kind, "interrupted")
		assert.equal(host.inspect(second.id).outcomePersisted, true)
	})

	it("surfaces a pending initial-write failure through both start and shutdown", async () => {
		const acceptance = deferred<void>()
		sandbox.stub(storage, "saveTaskletRecord").returns(acceptance.promise)
		const starting = host.start({ title: "starting", prompt: "work" })
		const startRejected = assert.rejects(starting, /acceptance failed/)
		const shutdown = host.shutdown()
		const shutdownRejected = assert.rejects(shutdown, (error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.match(error.message, /Tasklet shutdown failed/)
			assert.match(error.errors[0].message, /acceptance failed/)
			return true
		})
		acceptance.reject(new Error("acceptance failed"))
		await Promise.all([startRejected, shutdownRejected])
		sinon.assert.notCalled(constructed)
		assert.deepEqual(host.list(), [])
		assert.deepEqual(host.listActive(), [])
		assert.equal(host.shutdown(), shutdown)
		await assert.rejects(host.start({ title: "late", prompt: "work" }), /shutting down/)
	})

	it("rejects recursive/Goal ownership, invalid roots and empty assignments", async () => {
		for (const executionProfile of ["tasklet", "goal_child", "goal_coordinator", "goal_followup"] as const) {
			assert.throws(() => new TaskletHost({ taskId: "root", executionProfile }, {} as TaskletTaskOptions), /ordinary root/)
		}
		assert.throws(
			() => new TaskletHost({ taskId: "../escape", executionProfile: "standalone" }, {} as TaskletTaskOptions),
			/Invalid/,
		)
		await assert.rejects(host.start({ title: " ", prompt: "work" }), /non-empty/)
		await assert.rejects(host.start({ title: "work", prompt: " " }), /non-empty/)
		sinon.assert.notCalled(constructed)
	})
})
