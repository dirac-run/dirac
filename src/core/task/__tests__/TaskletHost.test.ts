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
import { ResponseOperation } from "@shared/responseTool"
import type { TaskInteractionRequest } from "../types/task-messenger"
import * as taskModule from "../index"
import { TaskletHost, type TaskletTaskOptions } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import { TaskletEscalationCleanupError } from "../TaskMessenger"
import { AgentConfigLoader } from "../tools/subagent/AgentConfigLoader"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

const deliverTaskletEvents = (taskModule.Task.prototype as unknown as {
	deliverTaskletEvents(history: import("@shared/messages/content").DiracStorageMessage[]): Promise<void>
}).deliverTaskletEvents

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
		hasPendingUserInput: sinon.SinonStub
	}
	const approved = { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
	const rejected = { action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT }
	const completed: TaskRunOutcome = { kind: "completed", response: "full result", completedAt: 123 }

	function taskOptions(): TaskletTaskOptions {
		return {
			workingConfiguration: createTaskWorkingConfiguration({
				settings: { mode: "act" } as any,
				apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-opus-4-20250514" },
				workspaceConfiguration: {} as any,
				executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
			}),
		} as TaskletTaskOptions
	}

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
			hasPendingUserInput: sandbox.stub().returns(false),
		}
		host = new TaskletHost(
			owner,
			taskOptions(),
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

	it("persists generic configuration with the default timeout and forwards it to the Task", async () => {
		const record = await host.start({ title: "Generic child", prompt: "Work" })
		assert.deepEqual(record.configuration, { includeHistory: false, timeoutSeconds: 600 })
		assert.deepEqual((await saved(record.id)).configuration, record.configuration)
		const params = constructed.firstCall.args[0] as taskModule.TaskParams
		assert.deepEqual(params.tasklet!.configuration, record.configuration)
		assert.equal(params.workingConfiguration.settings.mode, "act")
		assert.equal(params.workingConfiguration.apiConfiguration.actModeApiModelId, "claude-opus-4-20250514")
	})

	it("forwards named profile configuration and its model selection to the Task", async () => {
		const profile = {
			name: "reviewer", description: "Review an assignment", systemPrompt: "Review carefully.",
			skills: ["review"], tools: ["read_file", "respond"], modelId: "claude-sonnet-5",
		}
		const getCachedConfig = sandbox.stub().withArgs("reviewer").returns(profile)
		sandbox.stub(AgentConfigLoader, "getInstance").returns({ ready: async () => { }, getCachedConfig } as any)
		const record = await host.start({ title: "Review", prompt: "Review this change", agentName: "reviewer", timeoutSeconds: 45 })
		const params = constructed.firstCall.args[0] as taskModule.TaskParams
		assert.deepEqual(params.tasklet!.configuration, record.configuration)
		const { modelSelection, ...configuration } = record.configuration!
		assert.deepEqual((await saved(record.id)).configuration, { ...configuration, modelSelection: { provider: "anthropic", modelId: profile.modelId } })
		assert.deepEqual(configuration, {
			name: profile.name, description: profile.description, systemPrompt: profile.systemPrompt,
			skills: profile.skills, allowedTools: ["read_file", "respond"], includeHistory: false, timeoutSeconds: 45,
		})
		assert.equal(modelSelection?.provider, "anthropic")
		assert.equal(modelSelection?.modelId, profile.modelId)
		assert.equal(params.workingConfiguration.apiConfiguration.actModeApiModelId, profile.modelId)
	})

	for (const includeHistory of [false, true]) {
		it(`${includeHistory ? "snapshots" : "omits"} root history on start when includeHistory is ${includeHistory}`, async () => {
			const history = { messages: [{ role: "user" as const, content: "Root context" }], deletedRange: [1, 2] as [number, number] }
			const getParentHistory = sandbox.stub().returns(history)
			host = new TaskletHost(owner, { ...taskOptions(), getParentHistory }, constructed as unknown as typeof taskModule.Task)
			await host.start({ title: "History child", prompt: "Work", includeHistory, timeoutSeconds: 30 })
			const params = constructed.firstCall.args[0] as taskModule.TaskParams
			if (!includeHistory) {
				sinon.assert.notCalled(getParentHistory)
				assert.equal(params.tasklet!.initialHistory, undefined)
				return
			}
			sinon.assert.calledOnce(getParentHistory)
			assert.deepEqual(params.tasklet!.initialHistory, history)
			history.messages[0].content = "Changed after delegation"
			history.deletedRange[0] = 9
			assert.deepEqual(params.tasklet!.initialHistory, {
				messages: [{ role: "user", content: "Root context" }], deletedRange: [1, 2],
			})
		})
	}

	it("cancels an unfinished Task at its configured positive timeout", async () => {
		const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const record = await host.start({ title: "Timed child", prompt: "Work", timeoutSeconds: 2 })
		await clock.tickAsync(1999)
		sinon.assert.notCalled(children[0].task.abortTask)
		await clock.tickAsync(1)
		sinon.assert.calledOnceWithExactly(children[0].task.abortTask, {
			kind: "interrupted", reason: "Tasklet execution timed out after 2 seconds",
		})
		const stopped = await host.interrupt(record.id)
		assert.equal(stopped.outcome?.kind, "interrupted")
		assert.equal(stopped.outcomePersisted, true)
		assert.equal(clock.countTimers(), 0)
	})

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
		const other = new TaskletHost({ ...owner, taskId: "other" }, taskOptions())
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

	async function savedEvents(id: string): Promise<Array<{
		id: string; deliveredAt?: number; communication: {
			type: string; response?: { text: string }; request?: { id: string; status: string; resolution?: unknown }
		}
	}>> {
		return JSON.parse(await fs.readFile(path.join(
			getTaskDirectoryPath({ kind: "tasklet", rootTaskId: "root", taskletId: id }),
			GlobalFileNames.taskletEvents,
		), "utf8"))
	}

	async function respondingChild() {
		const child = await host.start({ title: "communicating child", prompt: "work" })
		const counterparty = (constructed.lastCall.args[0] as taskModule.TaskParams).tasklet!.counterparty
		return { child, counterparty }
	}

	describe("sleep", () => {
		afterEach(() => host.notifyUserMessage())

		it("wakes for pending responses without acknowledging or removing them", async () => {
			const { child, counterparty } = await respondingChild()
			await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "still pending" })
			const event = (await savedEvents(child.id))[0]
			assert.equal(host.isSleeping, false)
			for (let attempt = 0; attempt < 2; attempt++) {
				assert.deepEqual(await host.sleep(), { reason: "event", taskletId: child.id, eventId: event.id })
				assert.equal(host.isSleeping, false)
				assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
			}
			const delivery = (await host.prepareEventDelivery())!
			assert.deepEqual(delivery.content[0].taskletEventIds, [event.id])
			await delivery.acknowledge()
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const sleeping = host.sleep({ timeoutMs: 0 })
			await clock.tickAsync(0)
			assert.deepEqual(await sleeping, { reason: "timeout" })
			assert.equal(host.inspect(child.id).responses[0].text, "still pending")
		})

		it("wakes for pending interaction requests without resolving them", async () => {
			const entry = await registerInteraction()
			assert.deepEqual(await host.sleep(), { reason: "event", taskletId: entry.child.id, eventId: entry.requestId })
			assert.equal(host.inspect(entry.child.id).interactions[0].status, "pending")
			const delivery = (await host.prepareEventDelivery())!
			assert.deepEqual(delivery.content[0].taskletEventIds, [entry.requestId])
			assert.equal((await savedEvents(entry.child.id))[0].deliveredAt, undefined)
			await host.resolveInteraction(entry.child.id, entry.requestId, { operation: "reject" })
			await entry.waiting
		})

		it("wakes synchronously on response append while delivery still waits for persistence", async () => {
			const { child, counterparty } = await respondingChild()
			const entered = deferred<void>()
			const release = deferred<void>()
			const originalSave = storage.saveTaskletEvents
			const write = sandbox.stub(storage, "saveTaskletEvents").callsFake(async (address, events) => {
				entered.resolve()
				await release.promise
				await originalSave(address, events)
			})
			const sleeping = host.sleep()
			assert.equal(host.isSleeping, true)
			const response = counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "wake before disk" })
			let delivery: ReturnType<TaskletHost["prepareEventDelivery"]> | undefined
			try {
				assert.equal(host.isSleeping, false)
				await entered.promise
				const wake = await sleeping
				assert.equal(wake.reason, "event")
				if (wake.reason !== "event") assert.fail("Expected a communication wake")
				assert.equal(wake.taskletId, child.id)
				let delivered = false
				delivery = host.prepareEventDelivery().then((value) => { delivered = true; return value })
				await Promise.resolve()
				assert.equal(delivered, false)
				sinon.assert.calledOnce(write)
			} finally {
				release.resolve()
				await response
			}
			const prepared = (await delivery)!
			const stored = (await savedEvents(child.id))[0]
			assert.deepEqual(await sleeping, { reason: "event", taskletId: child.id, eventId: stored.id })
			assert.deepEqual(prepared.content[0].taskletEventIds, [stored.id])
			assert.equal(stored.deliveredAt, undefined)
		})

		it("wakes synchronously for a newly registered interaction request", async () => {
			const { child, counterparty } = await respondingChild()
			const cancellation = new AbortController()
			const sleeping = host.sleep()
			const waiting = counterparty.requestInteraction(request("sleep-request"), cancellation.signal)
			void waiting.catch(() => { })
			assert.equal(host.isSleeping, false)
			const interaction = host.inspect(child.id).interactions[0]
			assert.deepEqual(await sleeping, { reason: "event", taskletId: child.id, eventId: interaction.id })
			assert.equal(interaction.status, "pending")
			await host.resolveInteraction(child.id, interaction.id, { operation: "reject" })
			await waiting
		})

		it("filters both pending and arriving communications by tasklet ID", async () => {
			const first = await respondingChild()
			const second = await respondingChild()
			await first.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "excluded pending" })
			const sleeping = host.sleep({ taskletIds: [second.child.id] })
			assert.equal(host.isSleeping, true)
			await first.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "excluded arrival" })
			assert.equal(host.isSleeping, true)
			await second.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "included" })
			assert.deepEqual(await sleeping, {
				reason: "event", taskletId: second.child.id, eventId: (await savedEvents(second.child.id))[0].id,
			})
			assert.equal((await savedEvents(first.child.id)).every((event) => event.deliveredAt === undefined), true)
		})

		it("does not treat routine child activity or settlement as communication", async () => {
			const { child } = await respondingChild()
			const bindings = (constructed.lastCall.args[0] as taskModule.TaskParams).tasklet!
			const sleeping = host.sleep()
			await bindings.postStateToOwner()
			await bindings.postPresentationToOwner?.()
			bindings.updateBackgroundCommandState(true, child.id)
			await host.steer(child.id, "continue")
			await host.interrupt(child.id)
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await sleeping, { reason: "user_message" })
		})

		it("selects an already-pending communication from the requested tasklet", async () => {
			const first = await respondingChild()
			const second = await respondingChild()
			for (const entry of [first, second]) {
				await entry.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: entry.child.id })
			}
			assert.deepEqual(await host.sleep({ taskletIds: [second.child.id] }), {
				reason: "event", taskletId: second.child.id, eventId: (await savedEvents(second.child.id))[0].id,
			})
		})

		it("treats an empty filter as time/user-only even with pending and new events", async () => {
			const { counterparty } = await respondingChild()
			await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "pending" })
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const sleeping = host.sleep({ taskletIds: [], timeoutMs: 10 })
			await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "new" })
			assert.equal(host.isSleeping, true)
			await clock.tickAsync(9)
			assert.equal(host.isSleeping, true)
			await clock.tickAsync(1)
			assert.deepEqual(await sleeping, { reason: "timeout" })
			assert.equal(host.isSleeping, false)
			assert.equal(clock.countTimers(), 0)
		})

		it("lets user messages override every event filter and cancels the timer", async () => {
			const { child } = await respondingChild()
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			for (const taskletIds of [undefined, [], [child.id]]) {
				const sleeping = host.sleep({ taskletIds, timeoutMs: 100 })
				assert.equal(host.isSleeping, true)
				host.notifyUserMessage()
				assert.equal(host.isSleeping, false)
				assert.deepEqual(await sleeping, { reason: "user_message" })
				assert.equal(clock.countTimers(), 0)
			}
		})

		it("returns immediately for already-queued user input, including alongside a pending event", async () => {
			const { child, counterparty } = await respondingChild()
			await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "lower priority" })
			owner.hasPendingUserInput.returns(true)
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			assert.deepEqual(await host.sleep({ taskletIds: [child.id], timeoutMs: 100 }), { reason: "user_message" })
			assert.deepEqual(await host.sleep({ taskletIds: [], timeoutMs: 100 }), { reason: "user_message" })
			assert.equal(host.isSleeping, false)
			assert.equal(clock.countTimers(), 0)
			assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
		})

		it("does not retain a user notification when there is no pending sleep", async () => {
			host.notifyUserMessage()
			const sleeping = host.sleep()
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await sleeping, { reason: "user_message" })
		})

		it("does not lose a communication appended reentrantly while checking queued user input", async () => {
			const { child, counterparty } = await respondingChild()
			let response: Promise<void> | undefined
			let appended = false
			owner.hasPendingUserInput.callsFake(() => {
				if (!appended) {
					appended = true
					response = counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "during registration" })
				}
				return false
			})
			const sleeping = host.sleep()
			assert.equal(host.isSleeping, false)
			await response
			assert.deepEqual(await sleeping, { reason: "event", taskletId: child.id, eventId: (await savedEvents(child.id))[0].id })
		})

		it("does not lose a user notification sent reentrantly while registering sleep", async () => {
			owner.hasPendingUserInput.callsFake(() => {
				host.notifyUserMessage()
				return false
			})
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const sleeping = host.sleep({ timeoutMs: 100 })
			assert.equal(host.isSleeping, false)
			assert.deepEqual(await sleeping, { reason: "user_message" })
			assert.equal(clock.countTimers(), 0)
		})

		it("allows only one pending sleep and permits another after wake", async () => {
			const sleeping = host.sleep()
			await assert.rejects(host.sleep())
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await sleeping, { reason: "user_message" })
			const next = host.sleep()
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await next, { reason: "user_message" })
		})

		for (const eventFirst of [true, false]) {
			it(`settles the timer/event race once when ${eventFirst ? "the event" : "the timer"} wins`, async () => {
				const { child, counterparty } = await respondingChild()
				const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
				const cancellation = new AbortController()
				const add = sandbox.spy(cancellation.signal, "addEventListener")
				const remove = sandbox.spy(cancellation.signal, "removeEventListener")
				const sleeping = host.sleep({ timeoutMs: 10 }, cancellation.signal)
				const settled = sandbox.spy()
				void sleeping.then(settled)
				await clock.tickAsync(eventFirst ? 9 : 10)
				const response = counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "racing event" })
				if (eventFirst) assert.equal(host.isSleeping, false)
				await response
				const event = (await savedEvents(child.id))[0]
				assert.deepEqual(await sleeping, eventFirst
					? { reason: "event", taskletId: child.id, eventId: event.id }
					: { reason: "timeout" })
				await clock.tickAsync(100)
				cancellation.abort()
				host.notifyUserMessage()
				sinon.assert.calledOnce(settled)
				assert.equal(clock.countTimers(), 0)
				sinon.assert.calledOnce(add)
				sinon.assert.calledWith(remove, "abort", add.firstCall.args[1])
				assert.equal(event.deliveredAt, undefined)
				assert.deepEqual(await host.sleep(), { reason: "event", taskletId: child.id, eventId: event.id })
			})
		}

		it("accepts zero and maximum bounded integer timeouts", async () => {
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			for (const timeoutMs of [0, 2_147_483_647]) {
				const sleeping = host.sleep({ taskletIds: [], timeoutMs })
				assert.equal(host.isSleeping, true)
				await clock.tickAsync(timeoutMs)
				assert.deepEqual(await sleeping, { reason: "timeout" })
				assert.equal(host.isSleeping, false)
				assert.equal(clock.countTimers(), 0)
			}
		})

		it("cancels on signal abort and removes its listener and timer before accepting another sleep", async () => {
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const cancellation = new AbortController()
			const add = sandbox.spy(cancellation.signal, "addEventListener")
			const remove = sandbox.spy(cancellation.signal, "removeEventListener")
			const sleeping = host.sleep({ timeoutMs: 100 }, cancellation.signal)
			cancellation.abort(new Error("cancel sleep"))
			assert.equal(host.isSleeping, false)
			assert.deepEqual(await sleeping, { reason: "cancelled" })
			sinon.assert.calledOnce(add)
			sinon.assert.calledWith(remove, "abort", add.firstCall.args[1])
			assert.equal(clock.countTimers(), 0)
			const next = host.sleep()
			assert.equal(host.isSleeping, true)
			await clock.tickAsync(100)
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await next, { reason: "user_message" })
		})

		it("returns cancelled for an already-aborted signal without registering a listener or timer", async () => {
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const cancellation = new AbortController()
			cancellation.abort()
			const add = sandbox.spy(cancellation.signal, "addEventListener")
			assert.deepEqual(await host.sleep({ timeoutMs: 100 }, cancellation.signal), { reason: "cancelled" })
			assert.equal(host.isSleeping, false)
			sinon.assert.notCalled(add)
			assert.equal(clock.countTimers(), 0)
		})

		it("removes the abort listener when a user message wins", async () => {
			const cancellation = new AbortController()
			const add = sandbox.spy(cancellation.signal, "addEventListener")
			const remove = sandbox.spy(cancellation.signal, "removeEventListener")
			const sleeping = host.sleep(undefined, cancellation.signal)
			host.notifyUserMessage()
			assert.deepEqual(await sleeping, { reason: "user_message" })
			sinon.assert.calledOnce(add)
			sinon.assert.calledWith(remove, "abort", add.firstCall.args[1])
			const next = host.sleep()
			cancellation.abort()
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await next, { reason: "user_message" })
		})

		it("cancels pending sleep at shutdown and cannot sleep after shutdown", async () => {
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const cancellation = new AbortController()
			const add = sandbox.spy(cancellation.signal, "addEventListener")
			const remove = sandbox.spy(cancellation.signal, "removeEventListener")
			const sleeping = host.sleep({ timeoutMs: 100 }, cancellation.signal)
			const shutdown = host.shutdown()
			assert.equal(host.isSleeping, false)
			assert.deepEqual(await sleeping, { reason: "cancelled" })
			assert.equal(clock.countTimers(), 0)
			sinon.assert.calledOnce(add)
			sinon.assert.calledWith(remove, "abort", add.firstCall.args[1])
			await shutdown
			assert.deepEqual(await host.sleep(), { reason: "cancelled" })
			assert.equal(host.isSleeping, false)
		})

		it("rejects invalid timeouts and unbounded empty filters without leaving a pending sleep", async () => {
			const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			for (const timeoutMs of [-1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648, "10" as unknown as number]) {
				await assert.rejects(host.sleep({ timeoutMs }))
				assert.equal(host.isSleeping, false)
				assert.equal(clock.countTimers(), 0)
			}
			await assert.rejects(host.sleep({ taskletIds: [] }))
			assert.equal(host.isSleeping, false)
			const sleeping = host.sleep()
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await sleeping, { reason: "user_message" })
		})
	})

	function parentDeliveryFixture() {
		const history: import("@shared/messages/content").DiracStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "Continue supervising" }] },
		]
		const flush = sandbox.stub().resolves()
		const append = sandbox.stub().callsFake(async (block) => {
			const message = history.at(-1)!
			assert.ok(Array.isArray(message.content))
			message.content.push(block)
			return message
		})
		const root = {
			taskletHost: host,
			messageStateHandler: {
				getApiConversationHistory: () => history,
				getApiConversationProviderState: () => ({}),
				appendToLastApiConversationUserMessage: append,
				flushPendingWrites: flush,
			},
		}
		return {
			history, flush, append,
			deliver: (outbound = history) => deliverTaskletEvents.call(root, outbound),
		}
	}

	it("persists full response payloads independently of bounded parent previews and acknowledgement", async () => {
		const { child, counterparty } = await respondingChild()
		const text = "A".repeat(12_000) + "FULL_RESULT_TAIL"
		await counterparty.recordResponse({ operation: ResponseOperation.COMPLETE, text })
		const stored = await savedEvents(child.id)
		assert.equal(stored.length, 1)
		assert.equal(stored[0].communication.response?.text, text)
		assert.equal(stored[0].deliveredAt, undefined)
		const delivery = (await host.prepareEventDelivery())!
		assert.equal(delivery.content.length, 1)
		assert.match(delivery.content[0].text, /preview truncated/)
		assert.ok(!delivery.content[0].text.includes("FULL_RESULT_TAIL"))
		assert.equal(host.inspect(child.id).responses[0].text, text)
		await delivery.acknowledge()
		assert.equal(typeof (await savedEvents(child.id))[0].deliveredAt, "number")
		assert.equal((await savedEvents(child.id))[0].communication.response?.text, text)
		assert.equal(await host.prepareEventDelivery(), undefined)
		assert.equal(host.inspect(child.id).responses[0].text, text)
	})

	it("limits each parent delivery and retains the remainder without treating activity as communication", async () => {
		const { child, counterparty } = await respondingChild()
		const bindings = (constructed.lastCall.args[0] as taskModule.TaskParams).tasklet!
		await bindings.postStateToOwner()
		await bindings.postPresentationToOwner?.()
		assert.equal(await host.prepareEventDelivery(), undefined)
		sandbox.stub(Date, "now").returns(12345)
		for (let index = 0; index < 18; index++) await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: `update ${index}` })
		const first = (await host.prepareEventDelivery())!
		assert.equal(first.content.length, 16)
		assert.deepEqual(first.content.map((block) => JSON.parse(block.text.split("\n")[1]).response.text),
			Array.from({ length: 16 }, (_, index) => `update ${index}`))
		await first.acknowledge()
		const rest = (await host.prepareEventDelivery())!
		assert.equal(rest.content.length, 2)
		const deliveredIds = new Set(first.content.flatMap((block) => block.taskletEventIds ?? []))
		assert.ok(rest.content.every((block) => !deliveredIds.has(block.taskletEventIds![0])))
		await rest.acknowledge()
		assert.equal((await savedEvents(child.id)).length, 18)
		assert.equal(await host.prepareEventDelivery(), undefined)
	})

	it("does not acknowledge communications arriving while the previous acknowledgement is writing", async () => {
		const { child, counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "first" })
		const delivery = (await host.prepareEventDelivery())!
		const entered = deferred<void>()
		const release = deferred<void>()
		const originalSave = storage.saveTaskletEvents
		let writes = 0
		sandbox.stub(storage, "saveTaskletEvents").callsFake(async (address, events) => {
			if (++writes === 1) { entered.resolve(); await release.promise }
			await originalSave(address, events)
		})
		const acknowledgement = delivery.acknowledge()
		await entered.promise
		const arrival = counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "second" })
		release.resolve()
		await Promise.all([acknowledgement, arrival])
		const stored = await savedEvents(child.id)
		assert.equal(typeof stored[0].deliveredAt, "number")
		assert.equal(stored[1].deliveredAt, undefined)
		const next = (await host.prepareEventDelivery())!
		assert.equal(next.content.length, 1)
		assert.match(next.content[0].text, /second/)
	})

	it("surfaces failed event writes while retaining full responses for a subsequent complete snapshot", async () => {
		expectLoggerErrors()
		const { child, counterparty } = await respondingChild()
		const originalSave = storage.saveTaskletEvents
		const write = sandbox.stub(storage, "saveTaskletEvents")
		write.onFirstCall().rejects(new Error("event disk unavailable"))
		write.callsFake(originalSave)
		await assert.rejects(counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "retained despite disk failure" }), /event disk unavailable/)
		assert.equal(host.inspect(child.id).responses[0].text, "retained despite disk failure")
		assert.equal((await host.prepareEventDelivery())!.content.length, 1)
		assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "next update" })
		assert.equal((await savedEvents(child.id)).length, 2)
		assert.equal((await host.prepareEventDelivery())!.content.length, 2)
	})

	it("does not persist acknowledgement on failure and allows retrying that acknowledgement", async () => {
		expectLoggerErrors()
		const { child, counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "pending acknowledgement" })
		const delivery = (await host.prepareEventDelivery())!
		const originalSave = storage.saveTaskletEvents
		const write = sandbox.stub(storage, "saveTaskletEvents")
		write.onFirstCall().rejects(new Error("ack disk unavailable"))
		write.callsFake(originalSave)
		await assert.rejects(delivery.acknowledge(), /ack disk unavailable/)
		assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
		await delivery.acknowledge()
		assert.equal(typeof (await savedEvents(child.id))[0].deliveredAt, "number")
		assert.equal(await host.prepareEventDelivery(), undefined)
	})

	it("retries a failed acknowledgement through the next parent delivery without duplicating context", async () => {
		expectLoggerErrors()
		const { child, counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "receipt retry" })
		const parent = parentDeliveryFixture()
		const originalSave = storage.saveTaskletEvents
		const write = sandbox.stub(storage, "saveTaskletEvents").callsFake(originalSave)
		// The first write prepares delivery; the second acknowledges the persisted parent context.
		write.onSecondCall().rejects(new Error("receipt disk failure"))
		await assert.rejects(parent.deliver(), /receipt disk failure/)
		assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
		await parent.deliver()
		sinon.assert.calledOnce(parent.append)
		assert.equal((parent.history[0].content as unknown[]).length, 2)
		assert.equal(typeof (await savedEvents(child.id))[0].deliveredAt, "number")
	})

	it("rejects late acknowledgements after shutdown without starting another storage write", async () => {
		const { counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "pending" })
		const delivery = (await host.prepareEventDelivery())!
		await host.shutdown()
		const write = sandbox.spy(storage, "saveTaskletEvents")
		await assert.rejects(delivery.acknowledge(), /shutting down/)
		sinon.assert.notCalled(write)
	})

	it("retains events when parent flush fails and retries without duplicating canonical or outbound content", async () => {
		const { child, counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "deliver exactly once to context" })
		const parent = parentDeliveryFixture()
		parent.flush.onFirstCall().rejects(new Error("parent disk unavailable"))
		const outbound = structuredClone(parent.history)
		await assert.rejects(parent.deliver(outbound), /parent disk unavailable/)
		assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
		assert.equal((await host.prepareEventDelivery())!.content.length, 1)
		await parent.deliver(outbound)
		sinon.assert.calledOnce(parent.append)
		assert.equal((parent.history[0].content as unknown[]).length, 2)
		assert.equal((outbound[0].content as unknown[]).length, 2)
		assert.equal(typeof (await savedEvents(child.id))[0].deliveredAt, "number")
		await parent.deliver(outbound)
		sinon.assert.calledOnce(parent.append)
		sinon.assert.calledTwice(parent.flush)
	})

	it("retains pending delivery when parent append fails before flush or acknowledgement", async () => {
		const { child, counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "append retry" })
		const parent = parentDeliveryFixture()
		parent.append.onFirstCall().rejects(new Error("parent append failed"))
		await assert.rejects(parent.deliver(), /parent append failed/)
		sinon.assert.notCalled(parent.flush)
		assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
		assert.equal((parent.history[0].content as unknown[]).length, 1)
		await parent.deliver()
		assert.equal((parent.history[0].content as unknown[]).length, 2)
		assert.equal(await host.prepareEventDelivery(), undefined)
	})

	it("keeps arrivals during parent-context persistence pending for the next serial delivery", async () => {
		const { child, counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "before parent flush" })
		const parent = parentDeliveryFixture()
		const entered = deferred<void>()
		const release = deferred<void>()
		parent.flush.onFirstCall().callsFake(async () => { entered.resolve(); await release.promise })
		const delivery = parent.deliver()
		await entered.promise
		assert.equal((await savedEvents(child.id))[0].deliveredAt, undefined)
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "during parent flush" })
		release.resolve()
		await delivery
		const stored = await savedEvents(child.id)
		assert.equal(typeof stored[0].deliveredAt, "number")
		assert.equal(stored[1].deliveredAt, undefined)
		assert.equal((parent.history[0].content as unknown[]).length, 2)
		await parent.deliver()
		assert.equal((parent.history[0].content as unknown[]).length, 3)
		assert.equal(await host.prepareEventDelivery(), undefined)
	})

	it("does not duplicate a delivery when persisted and outbound user messages share an object", async () => {
		const { child, counterparty } = await respondingChild()
		await counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "shared user message" })
		const parent = parentDeliveryFixture()
		await parent.deliver()
		assert.equal((parent.history[0].content as unknown[]).length, 2)
		assert.equal(typeof (await savedEvents(child.id))[0].deliveredAt, "number")
		sinon.assert.calledOnce(parent.append)
	})

	it("persists resolved and retired request states without reviving pending authority", async () => {
		const resolved = await registerInteraction()
		await host.resolveInteraction(resolved.child.id, resolved.requestId, { operation: "reject" })
		await resolved.waiting
		const response = (await savedEvents(resolved.child.id))[0].communication.request!
		assert.equal(response.id, resolved.requestId)
		assert.equal(response.status, "resolved")
		assert.deepEqual(response.resolution, rejected)
		const retired = await registerInteraction()
		await host.interrupt(retired.child.id)
		await assert.rejects(retired.waiting, /retired/)
		assert.equal((await savedEvents(retired.child.id))[0].communication.request?.status, "retired")
		await assert.rejects(host.resolveInteraction(retired.child.id, retired.requestId, { operation: "approve" }), /not pending/)
	})

	it("joins communication persistence before shutdown settles", async () => {
		const { child, counterparty } = await respondingChild()
		const entered = deferred<void>()
		const release = deferred<void>()
		const originalSave = storage.saveTaskletEvents
		sandbox.stub(storage, "saveTaskletEvents").callsFake(async (address, events) => {
			entered.resolve()
			await release.promise
			await originalSave(address, events)
		})
		const response = counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "shutdown must await this" })
		await entered.promise
		let settled = false
		const shutdown = host.shutdown().then(() => { settled = true })
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			assert.equal(settled, false)
		} finally {
			release.resolve()
			await Promise.all([response, shutdown])
		}
		assert.equal((await savedEvents(child.id))[0].communication.response?.text, "shutdown must await this")
	})

	it("surfaces failed communication persistence through shutdown without skipping sibling cleanup", async () => {
		expectLoggerErrors()
		const { child, counterparty } = await respondingChild()
		const sibling = await host.start({ title: "sibling", prompt: "work" })
		sandbox.stub(storage, "saveTaskletEvents").rejects(new Error("communication disk failure"))
		await assert.rejects(counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "retained" }), /communication disk failure/)
		await assert.rejects(host.shutdown(), /Tasklet shutdown failed/)
		for (const execution of children) sinon.assert.calledOnce(execution.task.abortTask)
		assert.equal(host.inspect(child.id).responses[0].text, "retained")
		assert.equal(host.inspect(sibling.id).outcomePersisted, true)
	})

	it("rejects recursive ownership, invalid roots and empty assignments", async () => {
		for (const executionProfile of ["tasklet", "goal_child"] as const) {
			assert.throws(() => new TaskletHost({ ...owner, executionProfile }, taskOptions()), /Only root Tasks/)
		}
		assert.throws(
			() => new TaskletHost({ ...owner, taskId: "../escape" }, taskOptions()),
			/Invalid/,
		)
		await assert.rejects(host.start({ title: " ", prompt: "work" }), /non-empty/)
		await assert.rejects(host.start({ title: "work", prompt: " " }), /non-empty/)
		sinon.assert.notCalled(constructed)
	})
})
