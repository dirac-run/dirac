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
import { CardKind, CardStatus, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { TaskInteractionRequest } from "../types/task-messenger"
import * as taskModule from "../index"
import { TaskletHost, type TaskletTaskOptions } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import { TaskletEscalationCleanupError } from "../TaskMessenger"

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
	let owner: taskModule.TaskletOwner & {
		authorizePermission: sinon.SinonStub
		assertPermissionAllowed: sinon.SinonStub
		escalateInteraction: sinon.SinonStub
	}
	const approved = { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
	const rejected = { action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT }
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
		owner = {
			taskId: "root", executionProfile: "standalone",
			authorizePermission: sandbox.stub().resolves({ approved: false, assertCurrent: () => { } }),
			assertPermissionAllowed: sandbox.stub(),
			escalateInteraction: sandbox.stub().resolves(rejected),
		}
		host = new TaskletHost(
			owner,
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

	function request(id: string): TaskInteractionRequest {
		return {
			card: {
				id, kind: CardKind.GENERIC, header: "Permission", body: "Full operation", status: CardStatus.WAITING_FOR_INPUT,
				renderType: "text", requireApproval: true
			},
			permissionRequestKind: "manual_tool",
			permissionOperation: { kind: "commands", commands: ["echo private"] },
			toolCall: { name: "execute_command", arguments: { commands: ["echo private"] } },
		}
	}

	async function registerInteraction(input = request("card")) {
		const child = await host.start({ title: "requesting child", prompt: "work" })
		const counterparty = (constructed.lastCall.args[0] as taskModule.TaskParams).tasklet!.counterparty
		const cancellation = new AbortController()
		const waiting = counterparty.requestInteraction(input, cancellation.signal)
		// The original promise remains rejecting; individual assertions own cancellation failures.
		void waiting.catch(() => { })
		const interaction = host.inspect(child.id).interactions[0]
		return { child, counterparty, cancellation, waiting, requestId: interaction.id }
	}

	it("resolves explicit authorized approval against detached operation data exactly once", async () => {
		const input = request("permission-card")
		const entry = await registerInteraction(input)
		input.toolCall!.arguments.commands = ["changed by caller"]
		input.permissionOperation = { kind: "commands", commands: ["changed descriptor"] }
		const assertCurrent = sandbox.stub()
		owner.authorizePermission.resolves({ approved: true, assertCurrent })
		assert.deepEqual(await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "approve" }), { status: "resolved" })
		assert.deepEqual(await entry.waiting, approved)
		sinon.assert.calledOnce(owner.authorizePermission)
		const retained = owner.authorizePermission.firstCall.args[0] as TaskInteractionRequest
		assert.deepEqual(retained.toolCall!.arguments, { commands: ["echo private"] })
		assert.deepEqual(retained.permissionOperation, { kind: "commands", commands: ["echo private"] })
		sinon.assert.called(assertCurrent)
		sinon.assert.notCalled(owner.escalateInteraction)
		const resolved = host.inspect(entry.child.id).interactions[0]
		assert.equal(resolved.status, "resolved")
		assert.equal(typeof resolved.resolvedAt, "number")
		assert.deepEqual(resolved.resolution, approved)
		await assert.rejects(host.resolveInteraction(entry.child.id, entry.requestId, { operation: "approve" }), /not pending/)
		entry.cancellation.abort()
		assert.equal(host.inspect(entry.child.id).interactions[0].status, "resolved")
	})

	it("leaves unauthorized approval pending and prevents answer-based permission bypass", async () => {
		const entry = await registerInteraction()
		assert.deepEqual(await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "approve" }), { status: "requires_user_approval" })
		assert.equal(host.inspect(entry.child.id).interactions[0].status, "pending")
		sinon.assert.notCalled(owner.escalateInteraction)
		await assert.rejects(host.resolveInteraction(entry.child.id, entry.requestId, { operation: "answer", response: approved }), /Permission requests/)
		assert.deepEqual(await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "reject" }), { status: "resolved" })
		assert.deepEqual(await entry.waiting, rejected)
		sinon.assert.calledOnce(owner.authorizePermission)
		sinon.assert.notCalled(owner.assertPermissionAllowed)
	})

	it("answers questions and runtime choices without security authorization or mode changes", async () => {
		for (const requireApproval of [false, true]) {
			const input: TaskInteractionRequest = { card: { ...request("choice").card, requireApproval, requireFeedback: !requireApproval } }
			const entry = await registerInteraction(input)
			await assert.rejects(host.resolveInteraction(entry.child.id, entry.requestId, { operation: "approve" }), /Use answer/)
			const response = { ...approved, value: "retry", text: "Continue the same operation" }
			assert.deepEqual(await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "answer", response }), { status: "resolved" })
			assert.deepEqual(await entry.waiting, response)
			response.text = "mutated"
			assert.equal(host.inspect(entry.child.id).interactions[0].resolution?.text, "Continue the same operation")
		}
		sinon.assert.notCalled(owner.authorizePermission)
		sinon.assert.notCalled(owner.assertPermissionAllowed)
		sinon.assert.notCalled(owner.escalateInteraction)
	})

	it("rejects unknown, wrong-child and retired request identities even when children reuse card IDs", async () => {
		const first = await registerInteraction(request("same-card"))
		const second = await registerInteraction(request("same-card"))
		assert.notEqual(first.requestId, second.requestId)
		assert.equal(host.inspect(first.child.id).interactions[0].card.id, "same-card")
		await assert.rejects(host.resolveInteraction(second.child.id, first.requestId, { operation: "reject" }), /not pending/)
		await assert.rejects(host.resolveInteraction(first.child.id, "same-card", { operation: "reject" }), /not pending/)
		await assert.rejects(host.resolveInteraction("unknown-child", first.requestId, { operation: "reject" }), /does not belong/)
		first.cancellation.abort()
		await assert.rejects(first.waiting, /retired/)
		await assert.rejects(host.resolveInteraction(first.child.id, first.requestId, { operation: "reject" }), /not pending/)
		assert.equal(host.inspect(second.child.id).interactions[0].status, "pending")
		await host.resolveInteraction(second.child.id, second.requestId, { operation: "reject" })
		assert.deepEqual(await second.waiting, rejected)
	})

	it("rejects simultaneous decisions and rechecks authority before applying an asynchronous approval", async () => {
		const entry = await registerInteraction()
		const check = deferred<{ approved: boolean; assertCurrent: () => void }>()
		owner.authorizePermission.returns(check.promise)
		const resolution = host.resolveInteraction(entry.child.id, entry.requestId, { operation: "approve" })
		await assert.rejects(host.resolveInteraction(entry.child.id, entry.requestId, { operation: "reject" }), /already being resolved/)
		check.resolve({ approved: true, assertCurrent: () => { throw new Error("Parent authority changed") } })
		await assert.rejects(resolution, /Parent authority changed/)
		assert.equal(host.inspect(entry.child.id).interactions[0].status, "pending")
		await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "reject" })
		assert.deepEqual(await entry.waiting, rejected)
	})

	it("requires a fresh operation-specific user approval for every request", async () => {
		const first = await registerInteraction(request("same-card"))
		const second = await registerInteraction(request("same-card"))
		owner.escalateInteraction.resolves(approved)
		assert.deepEqual(await host.resolveInteraction(first.child.id, first.requestId, { operation: "escalate" }), { status: "resolved" })
		assert.deepEqual(await first.waiting, approved)
		sinon.assert.calledOnce(owner.escalateInteraction)
		assert.deepEqual(owner.escalateInteraction.firstCall.args[0], { id: first.child.id, title: first.child.title })
		assert.equal(owner.escalateInteraction.firstCall.args[1].id, first.requestId)
		assert.equal(host.inspect(second.child.id).interactions[0].status, "pending")
		assert.deepEqual(await host.resolveInteraction(second.child.id, second.requestId, { operation: "approve" }), { status: "requires_user_approval" })
		sinon.assert.calledOnce(owner.escalateInteraction)
		owner.escalateInteraction.resolves(rejected)
		await host.resolveInteraction(second.child.id, second.requestId, { operation: "escalate" })
		assert.deepEqual(await second.waiting, rejected)
	})

	it("rejects operation-changing escalation edits without consuming the pending request", async () => {
		const entry = await registerInteraction()
		owner.escalateInteraction.resolves({ ...approved, userEdits: { "outside.txt": "different operation" } })
		await assert.rejects(host.resolveInteraction(entry.child.id, entry.requestId, { operation: "escalate" }), /cannot change/)
		assert.equal(host.inspect(entry.child.id).interactions[0].status, "pending")
		await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "reject" })
		assert.deepEqual(await entry.waiting, rejected)
	})

	it("rechecks non-bypassable authority after user escalation and keeps a failed decision retryable", async () => {
		const entry = await registerInteraction()
		const decision = deferred<typeof approved>()
		owner.escalateInteraction.returns(decision.promise)
		const resolution = host.resolveInteraction(entry.child.id, entry.requestId, { operation: "escalate" })
		owner.assertPermissionAllowed.throws(new Error("Strict Plan mutation restriction"))
		decision.resolve(approved)
		await assert.rejects(resolution, /Strict Plan/)
		assert.equal(host.inspect(entry.child.id).interactions[0].status, "pending")
		await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "reject" })
		assert.deepEqual(await entry.waiting, rejected)
	})

	for (const operation of ["approve", "escalate"] as const) {
		it(`rejects late ${operation} after interruption without affecting a sibling`, async () => {
			const first = await registerInteraction()
			const sibling = await registerInteraction()
			const decision = deferred<any>()
			const callback = operation === "approve" ? owner.authorizePermission : owner.escalateInteraction
			callback.returns(decision.promise)
			const resolution = host.resolveInteraction(first.child.id, first.requestId, { operation })
			const resolutionRejected = assert.rejects(resolution, /retired/)
			const signal = callback.firstCall.args[operation === "approve" ? 1 : 2] as AbortSignal
			await host.interrupt(first.child.id)
			assert.equal(signal.aborted, true)
			await assert.rejects(first.waiting, /retired/)
			decision.resolve(operation === "approve" ? { approved: true, assertCurrent: () => { } } : approved)
			await resolutionRejected
			assert.equal(host.inspect(first.child.id).interactions[0].status, "retired")
			assert.equal(host.inspect(sibling.child.id).interactions[0].status, "pending")
			sinon.assert.notCalled(children[1].task.abortTask)
			await host.resolveInteraction(sibling.child.id, sibling.requestId, { operation: "reject" })
			assert.deepEqual(await sibling.waiting, rejected)
		})
	}

	it("joins escalation cancellation cleanup before root shutdown settles", async () => {
		const entry = await registerInteraction()
		const cleanup = deferred<void>()
		const aborted = deferred<void>()
		owner.escalateInteraction.callsFake(async (_child, _request, signal: AbortSignal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.resolve(); resolve() }, { once: true }))
			await cleanup.promise
			signal.throwIfAborted()
			return approved
		})
		const resolution = host.resolveInteraction(entry.child.id, entry.requestId, { operation: "escalate" })
		const resolutionRejected = assert.rejects(resolution, /retired/)
		let shutdownFinished = false
		const shutdown = host.shutdown().then(() => { shutdownFinished = true })
		await aborted.promise
		await assert.rejects(entry.waiting, /retired/)
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(shutdownFinished, false)
		await assert.rejects(host.resolveInteraction(entry.child.id, entry.requestId, { operation: "reject" }), /not pending/)
		cleanup.resolve()
		await Promise.all([resolutionRejected, shutdown])
		assert.equal(shutdownFinished, true)
		assert.equal(host.inspect(entry.child.id).interactions[0].status, "retired")
	})

	for (const timing of ["during shutdown", "before shutdown"] as const) {
		it(`retains failed escalation cleanup ${timing} while settling siblings`, async () => {
			const entry = await registerInteraction()
			const sibling = await registerInteraction()
			const failure = new TaskletEscalationCleanupError(new Error("root card cleanup failed"))
			const cleanup = deferred<void>()
			const aborted = deferred<void>()
			owner.escalateInteraction.callsFake(async (_child, _request, signal: AbortSignal) => {
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
					aborted.resolve()
					resolve()
				}, { once: true }))
				await cleanup.promise
				throw failure
			})
			const resolution = host.resolveInteraction(entry.child.id, entry.requestId, { operation: "escalate" })
			const resolutionRejected = assert.rejects(resolution, (error) => error === failure)
			const assertShutdownFailure = (error: unknown) => {
				assert.ok(error instanceof AggregateError)
				assert.ok(error.errors.includes(failure))
				return true
			}
			let shutdown: Promise<void>
			if (timing === "before shutdown") {
				entry.cancellation.abort()
				await aborted.promise
				cleanup.resolve()
				await resolutionRejected
				assert.equal(host.inspect(sibling.child.id).interactions[0].status, "pending")
				shutdown = assert.rejects(host.shutdown(), assertShutdownFailure)
			} else {
				let settled = false
				shutdown = assert.rejects(host.shutdown(), assertShutdownFailure).then(() => { settled = true })
				await aborted.promise
				await new Promise<void>((resolve) => setImmediate(resolve))
				assert.equal(settled, false, "Shutdown must join failed cleanup, not detach it")
				cleanup.resolve()
			}
			await Promise.all([resolutionRejected, shutdown])
			await assert.rejects(entry.waiting, /retired/)
			await assert.rejects(sibling.waiting, /retired/)
			for (const child of [entry.child, sibling.child]) {
				assert.equal(host.inspect(child.id).outcome?.kind, "interrupted")
				assert.equal(host.inspect(child.id).outcomePersisted, true)
				assert.equal(host.inspect(child.id).interactions[0].status, "retired")
			}
			await assert.rejects(host.shutdown(), assertShutdownFailure)
		})
	}

	it("retains detached requests per child and rejects duplicate, retired and late registrations", async () => {
		const first = await host.start({ title: "first", prompt: "first" })
		const second = await host.start({ title: "second", prompt: "second" })
		const firstOwner = (constructed.firstCall.args[0] as taskModule.TaskParams).tasklet!.counterparty
		const secondOwner = (constructed.secondCall.args[0] as taskModule.TaskParams).tasklet!.counterparty
		const input = request("same-card-id")
		const firstRejected = assert.rejects(firstOwner.requestInteraction(input, new AbortController().signal), /retired/)
		const secondRejected = assert.rejects(secondOwner.requestInteraction(request("same-card-id"), new AbortController().signal), /retired/)
		input.toolCall!.arguments.commands = ["changed"]
		const snapshot = host.inspect(first.id).interactions[0]
		assert.deepEqual(snapshot.toolCall!.arguments.commands, ["echo private"])
		Object.assign(snapshot.card, { body: "mutated snapshot" })
		assert.equal(host.inspect(first.id).interactions[0].card.body, "Full operation")
		assert.throws(() => firstOwner.requestInteraction(request("same-card-id"), new AbortController().signal), /already exists/)
		await host.interrupt(first.id)
		await firstRejected
		assert.equal(host.inspect(first.id).interactions[0].status, "retired")
		assert.equal(typeof host.inspect(first.id).interactions[0].retiredAt, "number")
		assert.equal(host.inspect(second.id).interactions[0].status, "pending")
		assert.throws(() => firstOwner.requestInteraction(request("late"), new AbortController().signal), /closed/)
		await host.shutdown()
		await secondRejected
		assert.equal(host.inspect(second.id).interactions[0].status, "retired")
		assert.throws(() => secondOwner.requestInteraction(request("late"), new AbortController().signal), /closed/)
	})

	it("retires signal-aborted requests without closing siblings and rejects pre-aborted registration", async () => {
		const record = await host.start({ title: "work", prompt: "work" })
		const owner = (constructed.firstCall.args[0] as taskModule.TaskParams).tasklet!.counterparty
		const aborted = new AbortController()
		aborted.abort(new Error("already aborted"))
		assert.throws(() => owner.requestInteraction(request("pre-aborted"), aborted.signal), /already aborted/)
		assert.deepEqual(host.inspect(record.id).interactions, [])
		const controller = new AbortController()
		const rejected = assert.rejects(owner.requestInteraction(request("first"), controller.signal), /retired/)
		controller.abort()
		await rejected
		assert.equal(host.inspect(record.id).interactions[0].status, "retired")
		assert.throws(() => owner.requestInteraction(request("first"), new AbortController().signal), /already exists/)
		const nextRejected = assert.rejects(owner.requestInteraction(request("next"), new AbortController().signal), /retired/)
		assert.equal(host.inspect(record.id).interactions[1].status, "pending")
		await host.interrupt(record.id)
		await nextRejected
	})

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
		const other = new TaskletHost({ ...owner, taskId: "other" }, {} as TaskletTaskOptions)
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
			assert.throws(() => new TaskletHost({ ...owner, executionProfile }, {} as TaskletTaskOptions), /ordinary root/)
		}
		assert.throws(
			() => new TaskletHost({ ...owner, taskId: "../escape" }, {} as TaskletTaskOptions),
			/Invalid/,
		)
		await assert.rejects(host.start({ title: " ", prompt: "work" }), /non-empty/)
		await assert.rejects(host.start({ title: "work", prompt: " " }), /non-empty/)
		sinon.assert.notCalled(constructed)
	})
})
