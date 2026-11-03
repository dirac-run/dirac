import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { saveApiConversationHistory, saveDiracMessages } from "@core/storage/conversationHistory"
import { loadTaskletEvents, loadTaskletRecords } from "@core/storage/taskStorage"
import { CardKind, CardStatus, DiracMessageType, TaskStatus, type DiracMessage } from "@shared/ExtensionMessage"
import type { DiracStorageMessage } from "@shared/messages/content"
import { ResponseOperation } from "@shared/responseTool"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { TaskletHost, type Task, type TaskletOwner, type TaskletTaskOptions, type TaskParams } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import type { TaskInteractionRequest } from "../types/task-messenger"
import { ToolExecutorCoordinator } from "../tools/ToolExecutorCoordinator"
import { createMockTaskConfig } from "../tools/__tests__/helpers/mockTaskConfig"
import type { ICardHandle, TaskletControls, TaskletInspection, TaskletTranscript, TaskletWakeResult } from "../tools/interfaces/IToolEnvironment"
import type { ToolExecutionEnvironment } from "../tools/interfaces/ToolEnvironmentFactory"
import { createSecondary as create } from "../tools/modules/use_subagents/tool"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => { resolve = res })
	return { promise, resolve }
}

/** Public tool dispatch and real host/storage; only child execution and surface cards are controlled. */
describe("TaskletsTool public controls", () => {
	let sandbox: sinon.SinonSandbox
	let directory: string
	let host: TaskletHost
	let coordinator: ToolExecutorCoordinator
	let config: ReturnType<typeof createMockTaskConfig>["config"]
	let children: ReturnType<typeof controlledTask>[]
	let constructed: sinon.SinonStub
	let cards: Array<ICardHandle & { update: sinon.SinonStub; finalize: sinon.SinonStub }>
	let owner: TaskletOwner & {
		authorizePermission: sinon.SinonStub
		assertPermissionAllowed: sinon.SinonStub
		escalateInteraction: sinon.SinonStub
		hasPendingUserInput: sinon.SinonStub
	}
	const approved = { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE }
	const rejected = { action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT }
	const fullText = `${"unabridged private detail ".repeat(300)}END-OF-FULL-CONTENT`

	function address(id: string) {
		return { kind: "tasklet" as const, rootTaskId: "root", taskletId: id }
	}

	function controlledTask(params: TaskParams) {
		const outcome = deferred<TaskRunOutcome>()
		const conversation: DiracStorageMessage[] = [{ role: "assistant", content: [{ type: "text", text: fullText }] }]
		const presentation: DiracMessage[] = [{
			id: "child-text", ts: 1, content: { type: DiracMessageType.MARKDOWN, content: fullText },
		}]
		const task = {
			stateView: { status: TaskStatus.WAITING_FOR_API },
			startTask: sandbox.stub().returns(outcome.promise),
			resumeTaskFromHistory: sandbox.stub().returns(outcome.promise),
			abortTask: sandbox.stub().callsFake(async (reason?: { reason?: string }) => {
				outcome.resolve({ kind: "interrupted", reason: reason?.reason ?? "test", interruptedAt: 124 })
			}),
			retirePersistence: sandbox.stub().callsFake(async () => {
				await saveApiConversationHistory(address(params.taskId!), conversation)
				await saveDiracMessages(address(params.taskId!), presentation)
			}),
			enqueueSteeringMessage: sandbox.stub().resolves("queued-steering-id"),
			messageStateHandler: {
				getApiConversationHistory: () => conversation,
				getDiracMessages: () => presentation,
			},
		}
		return { task, outcome, params, conversation, presentation }
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-public-controls-"))
		setVscodeHostProviderMock({ globalStorageFsPath: directory })
		children = []
		cards = []
		constructed = sandbox.stub().callsFake((params: TaskParams) => {
			const child = controlledTask(params)
			children.push(child)
			return child.task
		})
		owner = {
			taskId: "root", executionProfile: "standalone",
			authorizePermission: sandbox.stub().resolves({ approved: false, assertCurrent: () => { } }),
			assertPermissionAllowed: sandbox.stub(),
			escalateInteraction: sandbox.stub().resolves(rejected),
			hasPendingUserInput: sandbox.stub().returns(false),
		}
		const options = {
			workingConfiguration: createTaskWorkingConfiguration({
				settings: { mode: "act" } as any,
				apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "claude-opus-4-20250514" },
				workspaceConfiguration: {} as any,
				executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
			}),
		} as TaskletTaskOptions
		host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		const controls: TaskletControls = {
			start: (input) => host.start(input),
			list: () => host.list(),
			inspect: (id) => host.inspect(id),
			readTranscript: (id) => host.readTranscript(id),
			steer: (id, message) => host.steer(id, message),
			interrupt: (id, reason) => host.interrupt(id, reason),
			resume: (id, message) => host.resume(id, message),
			resolveInteraction: (id, requestId, decision) => host.resolveInteraction(id, requestId, decision),
			sleep: (options) => host.sleep(options),
		}
		config = createMockTaskConfig({ overrides: { hooksEnabled: false } }).config
		coordinator = new ToolExecutorCoordinator({
			create: () => {
				const callCards: ICardHandle[] = []
				return {
					orchestration: { tasklets: controls },
					ui: {
						createCard: async (params: Record<string, unknown>) => {
							const card = {
								...params, id: `control-card-${cards.length}`, status: CardStatus.RUNNING,
								update: sandbox.stub().callsFake(async (patch) => { Object.assign(card, patch) }),
								finalize: sandbox.stub().callsFake(async (status) => { Object.assign(card, { status }) }),
							} as unknown as typeof cards[number]
							cards.push(card)
							callCards.push(card)
							return card
						},
					},
					context: { save: sandbox.stub().resolves() },
					telemetry: { captureCustomMetadata: sandbox.stub() },
					getCustomMetadata: () => ({}),
					getCreatedCards: () => callCards,
				} as unknown as ToolExecutionEnvironment
			},
		})
		coordinator.registerModularTool(create())
	})

	afterEach(async () => {
		try {
			await host.shutdown()
		} finally {
			sandbox.restore()
			HostProvider.reset()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	async function dispatch(params: Record<string, unknown>): Promise<string> {
		const result = await coordinator.execute(config, { type: "tool_use", name: "tasklets", params })
		assert.equal(typeof result, "string")
		return result as string
	}

	async function call<T = unknown>(params: Record<string, unknown>): Promise<T> {
		const output = await dispatch(params)
		assert.ok(!output.startsWith("Execution failed:"), output)
		return JSON.parse(output) as T
	}

	async function inspect(id: string) {
		return call<TaskletInspection>({ operation: "inspect", tasklet_id: id })
	}

	function request(cardId: string, permission = false): TaskInteractionRequest {
		return {
			card: {
				id: cardId, kind: CardKind.GENERIC, header: permission ? "Permission" : "Question",
				body: fullText, status: CardStatus.WAITING_FOR_INPUT, renderType: "text",
				...(permission ? { requireApproval: true } : { requireFeedback: true }),
			},
			...(permission ? {
				permissionRequestKind: "manual_tool" as const,
				permissionOperation: { kind: "commands" as const, commands: ["echo private"] },
				toolCall: { name: "execute_command", arguments: { commands: ["echo private"] } },
			} : {}),
		}
	}

	function registerInteraction(child: ReturnType<typeof controlledTask>, cardId: string, permission = false) {
		const cancellation = new AbortController()
		const waiting = child.params.tasklet!.counterparty.requestInteraction(request(cardId, permission), cancellation.signal)
		void waiting.catch(() => { }) // Retirement assertions own the original rejection.
		const requestId = host.inspect(child.params.taskId!).interactions.at(-1)!.id
		return { waiting, cancellation, requestId }
	}

	function resolve(id: string, requestId: string, resolution: string, extra: Record<string, unknown> = {}) {
		return call({ operation: "resolve", tasklet_id: id, request_id: requestId, resolution, ...extra })
	}

	it("returns full retained results, responses and interactions, and live/persisted transcripts rather than previews", async () => {
		const record = await host.start({ title: "Full detail", prompt: "Work" })
		const response = { operation: ResponseOperation.PROGRESS, text: fullText }
		await children[0].params.tasklet!.counterparty.recordResponse(response)
		const interaction = registerInteraction(children[0], "full-question")
		const preview = await host.prepareEventDelivery()
		assert.ok(preview)
		assert.match(preview.content[0].text, /preview truncated/)
		assert.ok(!preview.content[0].text.includes("END-OF-FULL-CONTENT"))
		await preview.acknowledge()

		const listed = await call<TaskletInspection[]>({ operation: "list" })
		assert.deepEqual(listed, [await inspect(record.id)])
		assert.deepEqual(listed[0].responses, [response])
		assert.equal(listed[0].interactions[0].card.body, fullText)
		const transcript = await call<TaskletTranscript>({ operation: "transcript", tasklet_id: record.id })
		assert.deepEqual(transcript, { conversation: children[0].conversation, presentation: children[0].presentation })
		assert.equal(cards.at(-1)!.body, "Full transcript returned to the parent.")
		assert.equal(cards.at(-1)!.body!.includes(fullText), false)

		children[0].outcome.resolve({ kind: "completed", response: fullText, completedAt: 123 })
		// Join controlled settlement, not the tool's acceptance result.
		await host.interrupt(record.id)
		await assert.rejects(interaction.waiting, /retired/)
		const stopped = await inspect(record.id)
		assert.deepEqual(stopped.outcome, { kind: "completed", response: fullText, completedAt: 123 })
		assert.equal(stopped.outcomePersisted, true)
		assert.deepEqual(stopped.responses, [response])
		assert.deepEqual((await call<TaskletInspection[]>({ operation: "list" }))[0], stopped)
		assert.deepEqual(await call({ operation: "transcript", tasklet_id: record.id }), transcript)
		assert.equal(cards.every((card) => card.status === CardStatus.SUCCESS), true)
	})

	it("reports steering acceptance without claiming consumption or answering a pending question", async () => {
		const record = await host.start({ title: "Waiting child", prompt: "Ask" })
		const pending = registerInteraction(children[0], "question")
		const before = await call({ operation: "transcript", tasklet_id: record.id })
		assert.deepEqual(await call({ operation: "steer", tasklet_id: record.id, message: "New guidance" }), {
			id: record.id, messageId: "queued-steering-id", accepted: true,
		})
		sinon.assert.calledOnceWithExactly(children[0].task.enqueueSteeringMessage, "New guidance")
		const snapshot = await inspect(record.id)
		assert.equal(snapshot.outcome, undefined)
		assert.equal(snapshot.interactions[0].status, "pending")
		assert.deepEqual(snapshot.responses, [])
		assert.deepEqual(await call({ operation: "transcript", tasklet_id: record.id }), before)
		assert.deepEqual(await resolve(record.id, pending.requestId, "answer", { answer: "Explicit answer" }), { status: "resolved" })
		assert.equal((await pending.waiting).text, "Explicit answer")
	})

	it("interrupts only the selected child and requires explicit resume under its retained identity", async () => {
		const first = await host.start({ title: "First", prompt: "Original assignment" })
		const sibling = await host.start({ title: "Sibling", prompt: "Keep working" })
		const stopped = await call<TaskletInspection>({ operation: "interrupt", tasklet_id: first.id, message: "Pause this assignment" })
		assert.equal(stopped.outcome?.kind, "interrupted")
		assert.equal(stopped.outcomePersisted, true)
		sinon.assert.calledOnceWithExactly(children[0].task.abortTask, { kind: "interrupted", reason: "Pause this assignment" })
		sinon.assert.notCalled(children[1].task.abortTask)
		assert.equal((await inspect(sibling.id)).outcome, undefined)
		await call({ operation: "list" })
		await inspect(first.id)
		sinon.assert.calledTwice(constructed)
		assert.match(await dispatch({ operation: "steer", tasklet_id: first.id, message: "Not a resume" }), /Execution failed:.*not running/)
		assert.equal(cards.at(-1)!.status, CardStatus.ERROR)

		const resumed = await call<typeof first>({ operation: "resume", tasklet_id: first.id, message: "Continue with follow-up" })
		assert.equal(resumed.id, first.id)
		assert.equal(resumed.conversationUlid, first.conversationUlid)
		assert.equal(resumed.prompt, first.prompt)
		assert.equal(resumed.outcome, undefined)
		sinon.assert.calledThrice(constructed)
		sinon.assert.notCalled(children[2].task.startTask)
		sinon.assert.calledOnceWithExactly(children[2].task.resumeTaskFromHistory, undefined, { taskletResumeMessage: "Continue with follow-up" })
		assert.equal((await inspect(first.id)).outcomePersisted, false)
		assert.equal((await loadTaskletRecords("root")).find(({ id }) => id === first.id)!.outcome, undefined)
		assert.match(await dispatch({ operation: "resume", tasklet_id: first.id }), /Execution failed:.*has not settled/)
	})

	it("keeps question answers distinct from permissions and rejects stale resolved requests", async () => {
		const record = await host.start({ title: "Choices", prompt: "Ask" })
		const question = registerInteraction(children[0], "question")
		assert.match(await dispatch({ operation: "resolve", tasklet_id: record.id, request_id: question.requestId, resolution: "approve" }), /Use answer for questions/)
		assert.equal((await inspect(record.id)).interactions[0].status, "pending")
		await resolve(record.id, question.requestId, "answer", { answer: "The complete answer", action: "chosen-option" })
		assert.deepEqual(await question.waiting, { action: "chosen-option", response: DiracAskResponse.MESSAGE, value: "chosen-option", text: "The complete answer" })
		sinon.assert.notCalled(owner.authorizePermission)
		assert.match(await dispatch({ operation: "resolve", tasklet_id: record.id, request_id: question.requestId, resolution: "answer", answer: "Duplicate" }), /not pending/)
		const permission = registerInteraction(children[0], "permission", true)
		assert.match(await dispatch({ operation: "resolve", tasklet_id: record.id, request_id: permission.requestId, resolution: "answer", answer: "Yes", action: DiracAskResponse.APPROVE }), /Permission requests require/)
		assert.equal((await inspect(record.id)).interactions[1].status, "pending")
		await resolve(record.id, permission.requestId, "reject")
		assert.deepEqual(await permission.waiting, rejected)
	})

	it("limits approval to current parent authority and leaves denied or stale authorizations pending", async () => {
		const record = await host.start({ title: "Permission", prompt: "Work" })
		const permission = registerInteraction(children[0], "permission", true)
		assert.deepEqual(await resolve(record.id, permission.requestId, "approve"), { status: "requires_user_approval" })
		assert.equal((await inspect(record.id)).interactions[0].status, "pending")
		sinon.assert.notCalled(owner.escalateInteraction)
		assert.deepEqual(owner.authorizePermission.firstCall.args[0].permissionOperation, { kind: "commands", commands: ["echo private"] })

		const checking = deferred<void>()
		const authority = deferred<{ approved: boolean; assertCurrent: () => void }>()
		owner.authorizePermission.callsFake(() => { checking.resolve(); return authority.promise })
		const stale = dispatch({ operation: "resolve", tasklet_id: record.id, request_id: permission.requestId, resolution: "approve" })
		await checking.promise
		authority.resolve({ approved: true, assertCurrent: () => { throw new Error("Parent authority changed") } })
		assert.match(await stale, /Execution failed: Parent authority changed/)
		assert.equal((await inspect(record.id)).interactions[0].status, "pending")

		const assertCurrent = sandbox.stub()
		owner.authorizePermission.resolves({ approved: true, assertCurrent })
		assert.deepEqual(await resolve(record.id, permission.requestId, "approve"), { status: "resolved" })
		assert.deepEqual(await permission.waiting, approved)
		sinon.assert.calledTwice(assertCurrent)
		sinon.assert.calledOnce(owner.assertPermissionAllowed)
	})

	it("escalates the exact pending permission through the parent and rechecks permission limits", async () => {
		const record = await host.start({ title: "Escalation", prompt: "Work" })
		const permission = registerInteraction(children[0], "permission", true)
		const entered = deferred<void>()
		const user = deferred<typeof approved>()
		owner.escalateInteraction.callsFake(() => { entered.resolve(); return user.promise })
		const resolving = resolve(record.id, permission.requestId, "escalate")
		await entered.promise
		assert.equal((await inspect(record.id)).interactions[0].status, "pending")
		assert.deepEqual(owner.escalateInteraction.firstCall.args[0], { id: record.id, title: record.title })
		assert.equal(owner.escalateInteraction.firstCall.args[1].card.body, fullText)
		sinon.assert.calledOnce(owner.assertPermissionAllowed)
		user.resolve(approved)
		assert.deepEqual(await resolving, { status: "resolved" })
		assert.deepEqual(await permission.waiting, approved)
		sinon.assert.calledTwice(owner.assertPermissionAllowed)
		sinon.assert.notCalled(owner.authorizePermission)
	})

	it("rejects retired request IDs even after an explicit resume", async () => {
		const record = await host.start({ title: "Retirement", prompt: "Ask" })
		const pending = registerInteraction(children[0], "question")
		await call({ operation: "interrupt", tasklet_id: record.id })
		await assert.rejects(pending.waiting, /retired/)
		assert.equal((await inspect(record.id)).interactions[0].status, "retired")
		await call({ operation: "resume", tasklet_id: record.id })
		assert.match(await dispatch({ operation: "resolve", tasklet_id: record.id, request_id: pending.requestId, resolution: "answer", answer: "Too late" }), /not pending/)
		const fresh = registerInteraction(children[1], "question")
		assert.notEqual(fresh.requestId, pending.requestId)
		await resolve(record.id, fresh.requestId, "answer", { answer: "Current answer" })
		assert.equal((await fresh.waiting).text, "Current answer")
	})

	it("sleeps for selected communication without consuming it or joining the child", async () => {
		const first = await host.start({ title: "Selected", prompt: "Work" })
		const sibling = await host.start({ title: "Other", prompt: "Work" })
		await children[1].params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "Other communication" })
		const sleeping = call<TaskletWakeResult>({ operation: "sleep", tasklet_ids: [first.id] })
		// A subsequent dispatch completes only after sleep has registered its waiter.
		await inspect(first.id)
		assert.equal(host.isSleeping, true)
		await children[0].params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "Selected communication" })
		const wake = await sleeping
		assert.equal(wake.reason, "event")
		if (wake.reason !== "event") assert.fail("Expected selected communication")
		assert.equal(wake.taskletId, first.id)
		assert.equal(host.isSleeping, false)
		assert.deepEqual(await call({ operation: "sleep", tasklet_ids: [first.id] }), wake)
		const events = await loadTaskletEvents(address(first.id))
		assert.equal(events[0].id, wake.eventId)
		assert.equal(events[0].deliveredAt, undefined)
		assert.equal((await inspect(first.id)).outcome, undefined)
		assert.equal((await inspect(sibling.id)).outcome, undefined)
		sinon.assert.calledTwice(constructed)
		const delivery = await host.prepareEventDelivery()
		assert.equal(delivery!.content.length, 2)
		await delivery!.acknowledge()
		assert.equal(typeof (await loadTaskletEvents(address(first.id)))[0].deliveredAt, "number")
	})

	it("supports a time-only deadline despite pending communication", async () => {
		const record = await host.start({ title: "Communicating", prompt: "Work" })
		await children[0].params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "Still pending" })
		const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let woke = false
		const sleeping = call({ operation: "sleep", tasklet_ids: [], timeout_ms: 50 }).then((wake) => { woke = true; return wake })
		await inspect(record.id)
		assert.equal(host.isSleeping, true)
		await clock.tickAsync(49)
		assert.equal(woke, false)
		await clock.tickAsync(1)
		assert.deepEqual(await sleeping, { reason: "timeout" })
		assert.deepEqual(await call({ operation: "sleep" }), {
			reason: "event", taskletId: record.id, eventId: (await loadTaskletEvents(address(record.id)))[0].id,
		})
		assert.equal((await loadTaskletEvents(address(record.id)))[0].deliveredAt, undefined)
	})

	it("wakes unconditionally for user input, regardless of source filters or time-only waits", async () => {
		const record = await host.start({ title: "Selected", prompt: "Work" })
		for (const taskletIds of [[record.id], []]) {
			const sleeping = call({ operation: "sleep", tasklet_ids: taskletIds, timeout_ms: 60_000 })
			await inspect(record.id)
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await sleeping, { reason: "user_message" })
			assert.equal(host.isSleeping, false)
		}
		await children[0].params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "Not consumed by user wake" })
		owner.hasPendingUserInput.returns(true)
		assert.deepEqual(await call({ operation: "sleep" }), { reason: "user_message" })
		owner.hasPendingUserInput.returns(false)
		const wake = await call<TaskletWakeResult>({ operation: "sleep" })
		assert.equal(wake.reason, "event")
		assert.equal((await loadTaskletEvents(address(record.id)))[0].deliveredAt, undefined)
	})
})
