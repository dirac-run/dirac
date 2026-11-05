import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as storage from "@core/storage/taskStorage"
import { CardKind, CardStatus, TaskStatus } from "@shared/ExtensionMessage"
import { ResponseOperation } from "@shared/responseTool"
import { createTaskletId } from "@shared/taskletId"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { type Task, TaskletHost, type TaskletOwner, type TaskletTaskOptions, type TaskParams } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

/** Real contained record/event files; controlled engines establish ownership, not provider execution. */
describe("TaskletHost reconstruction and explicit reopening", () => {
	let sandbox: sinon.SinonSandbox
	let directory: string
	let hosts: TaskletHost[]
	let children: ReturnType<typeof controlledTask>[]
	let constructed: sinon.SinonStub
	let owner: TaskletOwner
	const completed: TaskRunOutcome = { kind: "completed", response: "Original complete result", completedAt: 123 }

	function controlledTask() {
		const outcome = deferred<TaskRunOutcome>()
		return {
			outcome,
			task: {
				stateView: { status: TaskStatus.WAITING_FOR_API },
				startTask: sandbox.stub().returns(outcome.promise),
				resumeTaskFromHistory: sandbox.stub().returns(outcome.promise),
				abortTask: sandbox.stub().callsFake(async () => {
					outcome.resolve({ kind: "interrupted", reason: "Stopped by owner", interruptedAt: 124 })
				}),
				retirePersistence: sandbox.stub().resolves(),
				enqueueSteeringMessage: sandbox.stub().resolves("steer"),
				messageStateHandler: { getApiConversationHistory: () => [], getDiracMessages: () => [] },
			},
		}
	}

	function newHost(overrides: Partial<TaskletTaskOptions> = {}) {
		const options = {
			workingConfiguration: createTaskWorkingConfiguration({
				settings: { mode: "act" } as any,
				apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-opus-4-20250514" },
				workspaceConfiguration: {} as any,
				executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
			}),
		} as TaskletTaskOptions
		const host = new TaskletHost(owner, { ...options, ...overrides }, constructed as unknown as typeof Task)
		hosts.push(host)
		return host
	}

	function address(id: string) {
		return { kind: "tasklet" as const, rootTaskId: "root", taskletId: id }
	}

	async function seed(outcome: TaskRunOutcome | undefined = completed) {
		const record: storage.TaskletRecord = {
			id: createTaskletId(),
			rootTaskId: "root",
			conversationUlid: "retained-conversation",
			title: "Retained assignment",
			prompt: "Original assignment",
			createdAt: 100,
			outcome,
		}
		await storage.saveTaskletRecord(record)
		return record
	}

	function interactionEvent(id: string, eventId: string, status: "pending" | "resolved" | "retired"): storage.TaskletEvent {
		return {
			id: eventId,
			taskletId: id,
			createdAt: 101,
			deliveredAt: 110,
			communication: {
				type: "interaction",
				request: {
					id: eventId,
					status,
					createdAt: 101,
					card: {
						id: `card-${eventId}`,
						kind: CardKind.GENERIC,
						header: "Permission",
						body: "Exact private command",
						status: CardStatus.WAITING_FOR_INPUT,
						renderType: "text",
						requireApproval: true,
					},
					permissionRequestKind: "manual_tool",
					permissionOperation: { kind: "commands", commands: ["echo private"] },
					toolCall: { name: "execute_command", arguments: { commands: ["echo private"] } },
					...(status === "resolved"
						? {
							resolvedAt: 105,
							resolution: { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE },
						}
						: status === "retired"
							? { retiredAt: 106 }
							: {}),
				},
			},
		}
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-reopening-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		hosts = []
		children = []
		constructed = sandbox.stub().callsFake(() => {
			const child = controlledTask()
			children.push(child)
			return child.task
		})
		owner = {
			taskId: "root",
			executionProfile: "standalone",
			authorizePermission: sandbox.stub(),
			assertPermissionAllowed: sandbox.stub(),
			escalateInteraction: sandbox.stub(),
			hasPendingUserInput: () => false,
		}
	})

	afterEach(async () => {
		for (const host of hosts) {
			try {
				await host.shutdown()
			} catch {
				/* Assertions below own intentional persistence failures. */
			}
		}
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	for (const acknowledge of [false, true]) {
		it(`retains a ${acknowledge ? "delivered" : "pending"} terminal notification across repeated reconstruction without duplicating it`, async () => {
			const original = newHost()
			const record = await original.start({ title: "Silent completed child", prompt: "Work" })
			children[0].outcome.resolve(completed)
			await original["children"].get(record.id)!.settlement
			const terminalEvents = await storage.loadTaskletEvents(address(record.id))
			assert.equal(terminalEvents.length, 1)
			assert.deepEqual(terminalEvents[0].communication, { type: "outcome", outcome: completed })
			if (acknowledge) await (await original.prepareEventDelivery())!.acknowledge()
			const savedEvents = await storage.loadTaskletEvents(address(record.id))
			await original.shutdown()

			for (let attempt = 0; attempt < 2; attempt++) {
				const reopened = newHost()
				await reopened.reconstruct()
				await reopened.reconstruct()
				sinon.assert.calledOnce(constructed)
				assert.deepEqual(await storage.loadTaskletEvents(address(record.id)), savedEvents)
				assert.deepEqual(reopened.inspect(record.id).responses, [])
				assert.deepEqual(reopened.inspect(record.id).outcome, completed)
				const delivery = await reopened.prepareEventDelivery()
				if (acknowledge) assert.equal(delivery, undefined)
				else {
					assert.ok(delivery)
					assert.equal(delivery.content.length, 1)
					assert.deepEqual(delivery.content[0].taskletEventIds, [terminalEvents[0].id])
					assert.deepEqual(await reopened.sleep(), { reason: "event", taskletId: record.id, eventId: terminalEvents[0].id })
				}
				await reopened.shutdown()
			}
		})
	}

	it("publishes a new terminal notification only after an explicitly resumed execution settles", async () => {
		const original = newHost()
		const record = await original.start({ title: "Same handle", prompt: "Work" })
		children[0].outcome.resolve(completed)
		await original["children"].get(record.id)!.settlement
		const firstEvents = await storage.loadTaskletEvents(address(record.id))
		assert.equal(firstEvents.length, 1)
		await (await original.prepareEventDelivery())!.acknowledge()
		const delivered = await storage.loadTaskletEvents(address(record.id))
		await original.shutdown()

		const reopened = newHost()
		await reopened.reconstruct()
		const resumed = await reopened.resume(record.id, "Explicit second assignment")
		assert.equal(resumed.id, record.id)
		assert.equal(resumed.conversationUlid, record.conversationUlid)
		assert.equal(resumed.outcome, undefined)
		assert.deepEqual(await storage.loadTaskletEvents(address(record.id)), delivered)
		const sleeping = reopened.sleep()
		await Promise.resolve() // Sleep first awaits this host's completed reconstruction.
		assert.equal(reopened.isSleeping, true)
		const secondOutcome: TaskRunOutcome = { kind: "failed", failedAt: 150, error: { name: "Error", message: "Silent resumed failure" } }
		children[1].outcome.resolve(secondOutcome)
		await reopened["children"].get(record.id)!.settlement
		const events = await storage.loadTaskletEvents(address(record.id))
		assert.equal(events.length, 2)
		assert.deepEqual(events[0], delivered[0])
		assert.notEqual(events[1].id, events[0].id)
		assert.deepEqual(events[1].communication, { type: "outcome", outcome: secondOutcome })
		assert.equal(events[1].deliveredAt, undefined)
		assert.deepEqual(await sleeping, { reason: "event", taskletId: record.id, eventId: events[1].id })
		assert.deepEqual(reopened.inspect(record.id).responses, [])
		const delivery = (await reopened.prepareEventDelivery())!
		assert.equal(delivery.content.length, 1)
		assert.deepEqual(delivery.content[0].taskletEventIds, [events[1].id])
		await delivery.acknowledge()
		await reopened.shutdown()
		const final = newHost()
		await final.reconstruct()
		sinon.assert.calledTwice(constructed)
		assert.equal((await storage.loadTaskletEvents(address(record.id))).length, 2)
		assert.equal(await final.prepareEventDelivery(), undefined)
	})

	it("preserves durable configuration across reopening without reinjecting parent history on resume", async () => {
		const getParentHistory = sandbox.stub().returns({ messages: [{ role: "user", content: "Original root context" }] })
		const original = newHost({ getParentHistory })
		const record = await original.start({ title: "Retained configuration", prompt: "Work", includeHistory: true, timeoutSeconds: 45 })
		const params = constructed.firstCall.args[0] as TaskParams
		assert.deepEqual(params.tasklet!.initialHistory, getParentHistory.firstCall.returnValue)
		children[0].outcome.resolve(completed)
		await original.interrupt(record.id)
		await original.shutdown()
		const reopened = newHost({ getParentHistory })
		await reopened.reconstruct()
		assert.deepEqual(reopened.inspect(record.id).configuration, record.configuration)
		await reopened.resume(record.id, "Follow up")
		const resumedParams = constructed.secondCall.args[0] as TaskParams
		assert.deepEqual(resumedParams.tasklet!.configuration, record.configuration)
		assert.equal(resumedParams.tasklet!.initialHistory, undefined)
		sinon.assert.calledOnce(getParentHistory)
		assert.deepEqual((await storage.loadTaskletRecords("root"))[0].configuration, record.configuration)
	})

	it("reconstructs cleanly closed completed handles without constructing or restarting engines", async () => {
		const original = newHost()
		const record = await original.start({ title: "Completed child", prompt: "Work" })
		children[0].outcome.resolve(completed)
		await original.interrupt(record.id)
		await original.shutdown()
		const reopened = newHost()
		const restore = reopened.reconstruct()
		assert.equal(reopened.reconstruct(), restore, "Repeated restoration shares one owned operation")
		await restore
		sinon.assert.calledOnce(constructed)
		assert.deepEqual(reopened.listActive(), [])
		assert.equal(reopened.inspect(record.id).outcomePersisted, true)
		assert.deepEqual(reopened.inspect(record.id).outcome, completed)
		assert.equal(reopened.inspect(record.id).executionStatus, undefined)
	})

	it("converts crash-active records into durable stopped handles without launching work", async () => {
		const record = await seed()
		delete record.outcome
		await storage.saveTaskletRecord(record)
		const host = newHost()
		await host.reconstruct()
		sinon.assert.notCalled(constructed)
		assert.deepEqual(host.listActive(), [])
		assert.equal(host.inspect(record.id).outcome?.kind, "interrupted")
		assert.deepEqual((await storage.loadTaskletRecords("root"))[0].outcome, host.inspect(record.id).outcome)
	})

	it("retires crash-pending approvals durably while preserving full communications and delivery receipts", async () => {
		const record = await seed()
		const events: storage.TaskletEvent[] = [
			interactionEvent(record.id, "old-pending", "pending"),
			interactionEvent(record.id, "old-resolved", "resolved"),
			interactionEvent(record.id, "old-retired", "retired"),
			{
				id: "full-result",
				taskletId: record.id,
				createdAt: 102,
				communication: {
					type: "response",
					response: { operation: ResponseOperation.COMPLETE, text: "full result ".repeat(900) },
				},
			},
		]
		await storage.saveTaskletEvents(address(record.id), events)
		const host = newHost()
		await host.reconstruct()
		const saved = await storage.loadTaskletEvents(address(record.id))
		assert.equal(saved[0].communication.type, "interaction")
		if (saved[0].communication.type !== "interaction") assert.fail("Expected retained request")
		assert.equal(saved[0].communication.request.status, "retired")
		assert.ok(saved[0].communication.request.retiredAt)
		assert.equal(saved[0].deliveredAt, 110)
		assert.deepEqual(saved.slice(1), events.slice(1))
		assert.deepEqual(
			host.inspect(record.id).interactions.map((entry) => entry.status),
			["retired", "resolved", "retired"],
		)
		await assert.rejects(host.resolveInteraction(record.id, "old-pending", { operation: "approve" }), /not pending/)
		sinon.assert.notCalled(owner.authorizePermission as sinon.SinonStub)
		const delivery = await host.prepareEventDelivery()
		assert.ok(delivery)
		assert.equal(delivery.content.length, 1, "Already delivered requests must not be re-delivered")
		assert.match(delivery.content[0].text, /preview truncated/)
		assert.equal(host.inspect(record.id).responses[0].text.length, "full result ".repeat(900).length)
		await delivery.acknowledge()
		await host.shutdown()
		const reopened = newHost()
		await reopened.reconstruct()
		assert.equal(await reopened.prepareEventDelivery(), undefined)
		assert.equal(reopened.inspect(record.id).interactions[0].status, "retired")
		sinon.assert.notCalled(constructed)
	})

	for (const outcome of [completed, { kind: "interrupted", reason: "Stopped", interruptedAt: 120 } satisfies TaskRunOutcome]) {
		it(`explicitly resumes the ${outcome.kind} conversation under the same identity without joining`, async () => {
			const record = await seed(outcome)
			const host = newHost()
			await host.reconstruct()
			const resumed = await host.resume(record.id, "Investigate this follow-up")
			assert.equal(resumed.id, record.id)
			assert.equal(resumed.conversationUlid, record.conversationUlid)
			assert.equal(resumed.outcome, undefined)
			assert.equal(host.inspect(record.id).outcomePersisted, false)
			const params = constructed.firstCall.args[0] as TaskParams
			assert.equal(params.taskId, record.id)
			assert.equal(params.conversationUlid, record.conversationUlid)
			assert.deepEqual(params.tasklet!.storageAddress, address(record.id))
			sinon.assert.notCalled(children[0].task.startTask)
			sinon.assert.calledOnceWithExactly(children[0].task.resumeTaskFromHistory, undefined, {
				taskletResumeMessage: "Investigate this follow-up",
			})
			assert.deepEqual(host.listActive(), [{ id: record.id, title: record.title }])
			await assert.rejects(host.resume(record.id, "Duplicate"), /not settled/)
			children[0].outcome.resolve(completed)
			await host.interrupt(record.id)
			await host.resume(record.id)
			sinon.assert.calledOnceWithExactly(children[1].task.resumeTaskFromHistory, undefined, { taskletResumeMessage: "" })
			assert.equal((await storage.loadTaskletRecords("root"))[0].conversationUlid, record.conversationUlid)
		})
	}

	it("keeps retired old requests inspectable but unresolvable after explicit resume", async () => {
		const record = await seed()
		await storage.saveTaskletEvents(address(record.id), [interactionEvent(record.id, "old", "pending")])
		const host = newHost()
		await host.reconstruct()
		await host.resume(record.id, "Fresh work only")
		assert.equal(host.inspect(record.id).interactions[0].status, "retired")
		await assert.rejects(host.resolveInteraction(record.id, "old", { operation: "approve" }), /not pending/)
		sinon.assert.notCalled(owner.authorizePermission as sinon.SinonStub)
	})

	it("rejects failed resume acceptance without constructing or losing the previous stopped record", async () => {
		const record = await seed()
		const host = newHost()
		await host.reconstruct()
		sandbox.stub(storage, "saveTaskletRecord").rejects(new Error("resume disk unavailable"))
		await assert.rejects(host.resume(record.id, "Follow up"), /resume disk unavailable/)
		sinon.assert.notCalled(constructed)
		assert.deepEqual(host.inspect(record.id).outcome, completed)
		assert.equal(host.inspect(record.id).outcomePersisted, true)
		assert.deepEqual((await storage.loadTaskletRecords("root"))[0], record)
	})

	it("rejects duplicate resume during acceptance and shutdown joins it without launching late work", async () => {
		const record = await seed()
		const host = newHost()
		await host.reconstruct()
		const entered = deferred<void>()
		const release = deferred<void>()
		const save = storage.saveTaskletRecord
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (value) => {
			if (!value.outcome) {
				entered.resolve()
				await release.promise
			}
			await save(value)
		})
		const resume = host.resume(record.id, "Late follow-up")
		await entered.promise
		await assert.rejects(host.resume(record.id), /not settled/)
		let shutdownFinished = false
		const shutdown = host.shutdown().then(() => {
			shutdownFinished = true
		})
		await Promise.resolve()
		assert.equal(shutdownFinished, false)
		release.resolve()
		await Promise.all([resume, shutdown])
		sinon.assert.notCalled(constructed)
		assert.equal(host.inspect(record.id).outcome?.kind, "interrupted")
		assert.equal(host.inspect(record.id).outcomePersisted, true)
		assert.deepEqual(host.listActive(), [])
		await assert.rejects(host.resume(record.id), /shutting down/)
	})

	it("interruption joins resume acceptance, then cancels and settles the admitted execution", async () => {
		const record = await seed()
		const host = newHost()
		await host.reconstruct()
		const entered = deferred<void>()
		const release = deferred<void>()
		const save = storage.saveTaskletRecord
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (value) => {
			if (!value.outcome) {
				entered.resolve()
				await release.promise
			}
			await save(value)
		})
		const resume = host.resume(record.id)
		await entered.promise
		let interrupted = false
		const interruption = host.interrupt(record.id).then((result) => {
			interrupted = true
			return result
		})
		await Promise.resolve()
		assert.equal(interrupted, false)
		release.resolve()
		await resume
		const result = await interruption
		sinon.assert.calledOnce(children[0].task.abortTask)
		assert.equal(result.outcome?.kind, "interrupted")
		assert.equal(result.outcomePersisted, true)
	})

	it("shutdown joins reconstruction and leaves recovered crash handles stopped", async () => {
		const record = await seed()
		delete record.outcome
		await storage.saveTaskletRecord(record)
		const entered = deferred<void>()
		const release = deferred<void>()
		const load = storage.loadTaskletEvents
		sandbox.stub(storage, "loadTaskletEvents").callsFake(async (value) => {
			entered.resolve()
			await release.promise
			return load(value)
		})
		const host = newHost()
		const reconstruction = host.reconstruct()
		await entered.promise
		let stopped = false
		const shutdown = host.shutdown().then(() => {
			stopped = true
		})
		await Promise.resolve()
		assert.equal(stopped, false)
		release.resolve()
		await Promise.all([reconstruction, shutdown])
		sinon.assert.notCalled(constructed)
		assert.equal(host.inspect(record.id).outcome?.kind, "interrupted")
		assert.deepEqual(host.listActive(), [])
	})

	it("surfaces reconstruction read failures through controls and shutdown rather than silently dropping records", async () => {
		sandbox.stub(storage, "loadTaskletRecords").rejects(new Error("corrupt contained record"))
		const host = newHost()
		await assert.rejects(host.reconstruct(), /corrupt contained record/)
		await assert.rejects(host.start({ title: "New", prompt: "Must not bypass reconstruction" }), /corrupt contained record/)
		await assert.rejects(host.resume(createTaskletId()), /corrupt contained record/)
		await assert.rejects(host.shutdown(), /Tasklet shutdown failed/)
		sinon.assert.notCalled(constructed)
	})

	it("fails reconstruction when request retirement cannot persist and prevents resuming the stale approval", async () => {
		expectLoggerErrors()
		const record = await seed()
		await storage.saveTaskletEvents(address(record.id), [interactionEvent(record.id, "stale", "pending")])
		sandbox.stub(storage, "saveTaskletEvents").rejects(new Error("retirement disk failure"))
		const host = newHost()
		await assert.rejects(host.reconstruct(), /retirement disk failure/)
		await assert.rejects(host.resume(record.id), /retirement disk failure/)
		await assert.rejects(host.resolveInteraction(record.id, "stale", { operation: "approve" }), /not pending/)
		await assert.rejects(host.shutdown(), /Tasklet shutdown failed/)
		sinon.assert.notCalled(constructed)
	})
})
