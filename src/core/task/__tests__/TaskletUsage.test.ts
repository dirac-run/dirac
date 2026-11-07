import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { reconstructTaskHistoryItem } from "@core/commands/reconstructTaskHistory"
import { getSavedPresentationHistory } from "@core/storage/conversationHistory"
import * as storage from "@core/storage/taskStorage"
import { TaskStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import type { HistoryItem } from "@shared/HistoryItem"
import { getTaskletUsage, taskletUsageTotal, type TaskletUsageSnapshot } from "@shared/taskletUsage"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { type Task, TaskletHost, type TaskletOwner, type TaskletTaskOptions, type TaskParams } from "../index"
import { MessageStateHandler } from "../message-state"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import { TaskState } from "../TaskState"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

function usage(cost: number, utilityCost = 0): TaskletUsageSnapshot {
	return {
		primary: {
			tokensIn: cost * 100,
			tokensOut: cost * 20,
			cacheWrites: cost * 2,
			cacheReads: cost * 4,
			cost,
			reasoningTokens: cost * 3,
		},
		utility: {
			tokensIn: utilityCost * 100,
			tokensOut: utilityCost * 20,
			cacheWrites: 0,
			cacheReads: 0,
			cost: utilityCost,
			reasoningTokens: utilityCost * 3,
		},
	}
}

/** Controlled engines and real nested record/root presentation files; not live model execution. */
describe("TaskletHost durable usage attribution", () => {
	let sandbox: sinon.SinonSandbox
	let directory: string
	let hosts: TaskletHost[]
	let children: ReturnType<typeof controlledTask>[]
	let constructed: sinon.SinonStub
	let owner: TaskletOwner
	let rootMessages: MessageStateHandler
	let history: HistoryItem | undefined
	const completed: TaskRunOutcome = { kind: "completed", response: "Assignment complete", completedAt: 123 }

	function controlledTask(params: TaskParams) {
		const outcome = deferred<TaskRunOutcome>()
		return {
			params,
			outcome,
			task: {
				stateView: { status: TaskStatus.WAITING_FOR_API },
				startTask: sandbox.stub().returns(outcome.promise),
				resumeTaskFromHistory: sandbox.stub().returns(outcome.promise),
				abortTask: sandbox.stub().callsFake(async () => {
					outcome.resolve({ kind: "interrupted", reason: "Owner interrupted", interruptedAt: 124 })
				}),
				retirePersistence: sandbox.stub().resolves(),
				messageStateHandler: {
					getApiConversationHistory: () => [], getDiracMessages: () => [],
					getPresentationOffset: () => -1, getPresentationStateGeneration: () => 0,
				},
			},
		}
	}

	function newHost() {
		const options = {
			workingConfiguration: createTaskWorkingConfiguration({
				settings: { mode: "act" } as any,
				apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-opus-4-20250514" },
				workspaceConfiguration: {} as any,
				executionOptions: {
					terminalReuseEnabled: true,
					vscodeTerminalExecutionMode: "backgroundExec",
					multiRootEnabled: false,
				},
			}),
		} as TaskletTaskOptions
		const host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		hosts.push(host)
		return host
	}

	function record(index: number, snapshot: TaskletUsageSnapshot) {
		children[index].params.tasklet!.recordUsage!(snapshot)
	}

	async function saved(id: string) {
		const records = await storage.loadTaskletRecords("root")
		return records.find((entry) => entry.id === id)!
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-usage-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		hosts = []
		children = []
		history = undefined
		rootMessages = new MessageStateHandler({
			taskId: "root",
			ulid: "root-conversation",
			taskState: new TaskState(),
			updateTaskHistory: async (item) => {
				history = item
				return [item]
			},
		})
		await rootMessages.addToDiracMessages({
			id: "root-user",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Root work" },
		})
		await rootMessages.addToDiracMessages({
			id: "root-api",
			ts: 2,
			content: { type: DiracMessageType.API_STATUS, status: { tokensIn: 10, tokensOut: 5, cost: 0.25 } },
		})
		constructed = sandbox.stub().callsFake((params: TaskParams) => {
			const child = controlledTask(params)
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
			withMutationAuthorization: (_toolName, mutation) => mutation(),
			retainMutationUntil: () => { },
			recordTaskletUsage: (id, snapshot) => rootMessages.upsertTaskletUsage(id, taskletUsageTotal(snapshot)),
		}
	})

	afterEach(async () => {
		for (const host of hosts) {
			try {
				await host.shutdown()
			} catch {
				/* Individual tests assert intentional write failures. */
			}
		}
		await rootMessages.retirePersistence()
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("replaces each child's cumulative snapshot while counting root and sibling spend once", async () => {
		const host = newHost()
		const first = await host.start({ title: "First", prompt: "One" })
		const second = await host.start({ title: "Second", prompt: "Two" })
		record(0, usage(1, 0.5))
		record(1, usage(2))
		record(0, usage(3, 0.5))
		record(0, usage(3, 0.5))
		children.forEach((child) => child.outcome.resolve(completed))
		await Promise.all([host.interrupt(first.id), host.interrupt(second.id)])

		const metrics = getApiMetrics(rootMessages.getDiracMessages())
		assert.equal(metrics.totalCost, 5.75)
		assert.equal(metrics.totalTokensIn, 560)
		assert.equal(metrics.totalTokensOut, 115)
		assert.equal(metrics.totalReasoningTokens, 16.5)
		assert.equal(getLastApiReqTotalTokens(rootMessages.getDiracMessages()), 15)
		const cards = rootMessages
			.getDiracMessages()
			.flatMap((message) => (message.content.type === DiracMessageType.CARD ? [getTaskletUsage(message.content.card)] : []))
		assert.equal(cards.length, 2)
		assert.deepEqual(new Set(cards.map((entry) => entry!.taskletId)), new Set([first.id, second.id]))
		assert.deepEqual(host.inspect(first.id).usage, usage(3, 0.5))
		assert.deepEqual((await saved(first.id)).usage, usage(3, 0.5))
		assert.equal(history && "totalCost" in history ? history.totalCost : undefined, 5.75)
		assert.equal(getApiMetrics((await getSavedPresentationHistory("root")).messages).totalCost, 5.75)
		const rebuilt = await reconstructTaskHistoryItem("root")
		assert.equal(rebuilt && "totalCost" in rebuilt ? rebuilt.totalCost : undefined, 5.75)
	})

	for (const kind of ["failed", "interrupted"] as const) {
		it(`retains incurred primary and Utility usage for ${kind} executions`, async () => {
			const host = newHost()
			const child = await host.start({ title: kind, prompt: "Work before stopping" })
			record(0, usage(2, 0.5))
			if (kind === "failed") {
				children[0].outcome.resolve({ kind, failedAt: 125, error: { name: "Error", message: "Provider failed" } })
			}
			const stopped = await host.interrupt(child.id)
			assert.equal(stopped.outcome?.kind, kind)
			assert.equal(stopped.outcomePersisted, true)
			assert.deepEqual((await saved(child.id)).usage, usage(2, 0.5))
			assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 2.75)
		})
	}

	it("passes lifetime usage into same-identity resumption without adding historical spend again", async () => {
		const host = newHost()
		const child = await host.start({ title: "Reopen", prompt: "Original work" })
		record(0, usage(2, 0.5))
		children[0].outcome.resolve(completed)
		await host.interrupt(child.id)
		await host.resume(child.id, "Follow up")
		assert.equal(children[1].params.taskId, child.id)
		assert.equal(children[1].params.conversationUlid, child.conversationUlid)
		assert.deepEqual(children[1].params.tasklet!.usage, usage(2, 0.5))
		record(1, usage(2, 0.5))
		record(1, usage(3, 0.75))
		children[1].outcome.resolve(completed)
		await host.interrupt(child.id)
		assert.deepEqual((await saved(child.id)).usage, usage(3, 0.75))
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 4)
		assert.equal(rootMessages.getDiracMessages().length, 3)
	})

	it("reconstructs stopped snapshots without constructing engines and reconciles root projection idempotently", async () => {
		const original = newHost()
		const child = await original.start({ title: "Durable", prompt: "Work" })
		record(0, usage(2, 0.5))
		children[0].outcome.resolve(completed)
		await original.interrupt(child.id)
		await original.shutdown()
		// Simulate a restored root presentation that predates the latest child projection.
		await rootMessages.overwriteDiracMessages(rootMessages.getDiracMessages().slice(0, 2))
		const reopened = newHost()
		await reopened.reconstruct()
		sinon.assert.calledOnce(constructed)
		assert.deepEqual(reopened.inspect(child.id).usage, usage(2, 0.5))
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 0.25)
		await reopened.reconcileRootProjection()
		await reopened.reconcileRootProjection()
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 2.75)
		assert.equal(rootMessages.getDiracMessages().length, 3)
		sinon.assert.calledOnce(constructed)
	})

	it("replaces an older restored root snapshot with the durable child total", async () => {
		const original = newHost()
		const child = await original.start({ title: "Latest snapshot", prompt: "Work" })
		record(0, usage(2, 0.5))
		children[0].outcome.resolve(completed)
		await original.interrupt(child.id)
		await original.shutdown()
		await rootMessages.upsertTaskletUsage(child.id, taskletUsageTotal(usage(1)))
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 1.25)
		const reopened = newHost()
		await reopened.reconstruct()
		await reopened.reconcileRootProjection()
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 2.75)
		assert.equal(rootMessages.getDiracMessages().length, 3)
		assert.deepEqual((await saved(child.id)).usage, usage(2, 0.5))
	})

	it("preserves crash-active incurred usage while reconstructing a stopped handle", async () => {
		const original = newHost()
		const child = await original.start({ title: "Crash interrupted", prompt: "Work" })
		record(0, usage(2, 0.5))
		children[0].outcome.resolve(completed)
		await original.interrupt(child.id)
		await original.shutdown()
		const durable = await saved(child.id)
		delete durable.outcome
		await storage.saveTaskletRecord(durable)
		const project = sandbox.spy(owner, "recordTaskletUsage")
		const reopened = newHost()
		await reopened.reconstruct()
		sinon.assert.notCalled(project)
		await reopened.reconcileRootProjection()
		sinon.assert.calledOnce(constructed)
		assert.equal(reopened.inspect(child.id).outcome?.kind, "interrupted")
		assert.equal(reopened.inspect(child.id).outcomePersisted, true)
		assert.deepEqual((await saved(child.id)).usage, usage(2, 0.5))
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 2.75)
	})

	it("detaches callback snapshots from caller mutation", async () => {
		const host = newHost()
		const child = await host.start({ title: "Detached", prompt: "Work" })
		const snapshot = usage(1, 0.5)
		record(0, snapshot)
		snapshot.primary.cost = 999
		snapshot.utility.tokensIn = 999
		children[0].outcome.resolve(completed)
		await host.interrupt(child.id)
		assert.deepEqual((await saved(child.id)).usage, usage(1, 0.5))
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 1.75)
	})

	it("joins gated usage writes before terminal persistence and admits resumption only after settlement", async () => {
		const host = newHost()
		const child = await host.start({ title: "Ordered", prompt: "Work" })
		const entered = deferred<void>()
		const release = deferred<void>()
		const write = storage.saveTaskletRecord
		const writes: storage.TaskletRecord[] = []
		sandbox.stub(storage, "saveTaskletRecord").callsFake(async (snapshot) => {
			writes.push(structuredClone(snapshot))
			if (writes.length === 1) {
				entered.resolve()
				await release.promise
			}
			await write(snapshot)
		})
		record(0, usage(1))
		await entered.promise
		record(0, usage(2, 0.5))
		children[0].outcome.resolve(completed)
		let settled = false
		const stopping = host.interrupt(child.id).then(() => {
			settled = true
		})
		try {
			await assert.rejects(host.resume(child.id), /not settled successfully/)
			assert.equal(settled, false)
			assert.equal((await saved(child.id)).usage, undefined)
		} finally {
			release.resolve()
		}
		await stopping
		assert.deepEqual(
			writes.map((entry) => entry.usage),
			[usage(1), usage(2, 0.5), usage(2, 0.5)],
		)
		assert.equal(writes.at(-1)!.outcome?.kind, "completed")
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 2.75)
		await host.resume(child.id)
		assert.deepEqual(children[1].params.tasklet!.usage, usage(2, 0.5))
	})

	it("persists availability through disk reconstruction and replaces cards without starting historical engines", async () => {
		const known = {
			inputTokens: true,
			outputTokens: true,
			cost: true,
			reasoningTokens: true,
			cacheWrites: true,
			cacheReads: true,
		}
		const unknown = { ...known, cost: false, reasoningTokens: false, cacheWrites: false, cacheReads: false }
		const snapshot: TaskletUsageSnapshot = {
			primary: { ...usage(2).primary, usageObserved: true, usageAvailability: known },
			utility: { tokensIn: 5, tokensOut: 1, cost: 0, reasoningTokens: 0, usageObserved: true, usageAvailability: unknown },
		}
		const original = newHost()
		const child = await original.start({ title: "availability", prompt: "Private work" })
		record(0, snapshot)
		children[0].outcome.resolve(completed)
		await original.interrupt(child.id)
		await original.shutdown()
		assert.deepEqual((await saved(child.id)).usage, snapshot)
		const reopened = newHost()
		await reopened.reconstruct()
		await reopened.reconcileRootProjection()
		await reopened.reconcileRootProjection()
		sinon.assert.calledOnce(constructed)
		const cards = rootMessages
			.getDiracMessages()
			.flatMap((message) => (message.content.type === DiracMessageType.CARD ? [getTaskletUsage(message.content.card)] : []))
		assert.equal(cards.length, 1)
		assert.deepEqual(cards[0]!.usageAvailability, unknown)
		assert.equal(cards[0]!.cost, 2)
		await reopened.resume(child.id, "Explicit follow-up")
		assert.deepEqual(children[1].params.tasklet!.usage, snapshot)
		assert.equal(getApiMetrics(rootMessages.getDiracMessages()).totalCost, 2.25)
	})

	it("surfaces a usage record write failure through settlement and root shutdown", async () => {
		expectLoggerErrors()
		const host = newHost()
		const child = await host.start({ title: "Write failure", prompt: "Work" })
		sandbox.stub(storage, "saveTaskletRecord").rejects(new Error("Usage disk failure"))
		record(0, usage(2, 0.5))
		children[0].outcome.resolve(completed)
		await assert.rejects(host.interrupt(child.id), /interruption failed/)
		assert.deepEqual(host.inspect(child.id).usage, usage(2, 0.5))
		assert.equal(host.inspect(child.id).outcomePersisted, false)
		assert.match(host.inspect(child.id).settlementError!.message, /Usage disk failure/)
		await assert.rejects(host.shutdown(), /shutdown failed/)
		await assert.rejects(host.resume(child.id), /shutting down/)
	})

	it("retains the durable child snapshot and surfaces failed root projection during settlement", async () => {
		expectLoggerErrors()
		const host = newHost()
		const child = await host.start({ title: "Projection failure", prompt: "Work" })
		owner.recordTaskletUsage = sandbox.stub().rejects(new Error("Root accounting unavailable"))
		record(0, usage(2, 0.5))
		record(0, usage(4, 1))
		children[0].outcome.resolve(completed)
		await assert.rejects(host.interrupt(child.id), /interruption failed/)
		assert.deepEqual((await saved(child.id)).usage, usage(4, 1))
		assert.equal((await saved(child.id)).outcome?.kind, "completed")
		assert.equal(host.inspect(child.id).outcomePersisted, false)
		assert.match(host.inspect(child.id).settlementError!.message, /Root accounting unavailable/)
		await assert.rejects(host.shutdown(), /shutdown failed/)
	})
})
