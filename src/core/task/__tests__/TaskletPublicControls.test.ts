import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { getSavedPresentationHistory, saveApiConversationHistory, saveDiracMessages } from "@core/storage/conversationHistory"
import { loadTaskletEvents, loadTaskletRecords } from "@core/storage/taskStorage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { isTaskletId } from "@shared/taskletId"
import { Logger } from "@shared/services/Logger"
import { readTaskletPresentation } from "@shared/taskletPresentation"
import { getTaskletUsage, taskletUsageTotal, type TaskletUsageSnapshot } from "@shared/taskletUsage"
import { CardKind, CardStatus, DiracMessageType, TaskStatus, type DiracMessage } from "@shared/ExtensionMessage"
import type { DiracStorageMessage } from "@shared/messages/content"
import { ResponseOperation } from "@shared/responseTool"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { TaskletHost, type Task, type TaskletOwner, type TaskletTaskOptions, type TaskParams } from "../index"
import type { TaskRunOutcome } from "../TaskRunOutcome"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import type { TaskInteractionRequest } from "../types/task-messenger"
import { ToolExecutorCoordinator } from "../tools/ToolExecutorCoordinator"
import { createMockTaskConfig } from "../tools/__tests__/helpers/mockTaskConfig"
import { buildOrchestrationTrait } from "../tools/adapters/traits/OrchestrationTraitBuilder"
import type { ICardHandle, TaskletControls, TaskletInspection, TaskletTranscript, TaskletWakeResult } from "../tools/interfaces/IToolEnvironment"
import type { ToolExecutionEnvironment } from "../tools/interfaces/ToolEnvironmentFactory"
import { create, createSecondary } from "../tools/modules/use_subagents/tool"
import { AgentConfigLoader } from "../tools/subagent/AgentConfigLoader"

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
	let rootMessages: MessageStateHandler | undefined
	let options: TaskletTaskOptions
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
		rootMessages = undefined
		sandbox.stub(AgentConfigLoader, "getInstance").returns({
			ready: async () => { },
			getCachedConfig: (name: string) => name === "Research" ? {
				name: "Research", description: "Research assignment", systemPrompt: "Investigate independently", tools: ["read_file"],
			} : undefined,
			resolveSubagentNameForTool: (name: string) => name === "subagent_research" ? "Research" : undefined,
			isDynamicSubagentTool: (name: string) => name === "subagent_research",
		} as unknown as AgentConfigLoader)
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
		options = {
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
		config = createMockTaskConfig({
			overrides: { executionProfile: "standalone", hooksEnabled: false, subagentsEnabled: true },
			callbackOverrides: { tasklets: controls },
		}).config
		config.messageState.getDiracMessages.callsFake(() => rootMessages?.getDiracMessages() ?? [])
		coordinator = new ToolExecutorCoordinator({
			create: (toolConfig, toolName) => {
				const callCards: ICardHandle[] = []
				const orchestration = buildOrchestrationTrait(toolConfig)
				assert.equal("runSubagent" in orchestration, false)
				assert.equal("createSubagentRuntime" in toolConfig.callbacks, false)
				return {
					config: toolConfig,
					toolName,
					logging: { warn: sandbox.stub(), debug: sandbox.stub() },
					orchestration,
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
		coordinator.registerModularTool(createSecondary())
	})

	afterEach(async () => {
		try {
			await host.shutdown()
			await rootMessages?.retirePersistence()
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

	interface SpawnResult {
		subagents: Array<{ index: number; id?: string; title?: string; accepted: boolean; error?: string; outcome?: TaskRunOutcome }>
	}

	async function spawn(assignments: unknown[], toolName = "use_subagents"): Promise<SpawnResult> {
		const params = toolName === "use_subagents" ? { subagents: assignments } : assignments[0] as Record<string, unknown>
		const result = await coordinator.execute(config, { type: "tool_use", name: toolName, params })
		assert.equal(typeof result, "string")
		return JSON.parse(result as string) as SpawnResult
	}

	function acceptedId(result: SpawnResult, index = 0): string {
		const entry = result.subagents[index]
		assert.equal(entry.accepted, true, entry.error)
		assert.equal(typeof entry.id, "string")
		assert.ok(isTaskletId(entry.id!))
		return entry.id!
	}

	async function projectRoot() {
		rootMessages = new MessageStateHandler({
			taskId: "root", ulid: "root-conversation", taskState: new TaskState(), updateTaskHistory: async () => [],
		})
		await rootMessages.addToDiracMessages({
			id: "root-user", ts: 1, content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Parent assignment" },
		})
		owner.projectTasklet = (data) => rootMessages!.upsertTaskletPresentation(data)
		owner.recordTaskletUsage = (id, usage) => rootMessages!.upsertTaskletUsage(id, taskletUsageTotal(usage))
	}

	function presentation(id: string) {
		const message = rootMessages!.getDiracMessages().find((message) => message.id === `tasklet:${id}`)
		assert.ok(message)
		assert.equal(message.content.type, DiracMessageType.CARD)
		if (message.content.type !== DiracMessageType.CARD) assert.fail("Expected tasklet card")
		assert.equal(message.content.card.id, message.id)
		const data = readTaskletPresentation(message.content.card)
		assert.ok(data)
		return { card: message.content.card, data }
	}

	it("returns a generic startup handle while the assignment remains active and its invocation card is final", async () => {
		const result = await spawn([{ task_title: "Trace startup", prompt: "Investigate the startup path" }])
		const id = acceptedId(result)
		assert.equal(result.subagents[0].outcome, undefined)
		assert.equal((await inspect(id)).outcome, undefined)
		assert.deepEqual(host.listActive(), [{ id, title: "Trace startup" }])
		sinon.assert.calledOnceWithExactly(children[0].task.startTask, "Investigate the startup path")
		sinon.assert.notCalled(children[0].task.retirePersistence)
		assert.equal(cards[0].status, CardStatus.SUCCESS)
		sinon.assert.calledOnceWithExactly(cards[0].finalize, CardStatus.SUCCESS)
	})

	it("dispatches a configured named agent through the same asynchronous host and public controls", async () => {
		assert.equal(coordinator.has("subagent_research"), true)
		const id = acceptedId(await spawn([{ task_title: "Named research", prompt: "Investigate configured tools" }], "subagent_research"))
		const snapshot = await inspect(id)
		assert.equal(snapshot.outcome, undefined)
		assert.equal(snapshot.configuration?.name, "Research")
		assert.equal(snapshot.configuration?.systemPrompt, "Investigate independently")
		assert.deepEqual(snapshot.configuration?.allowedTools, ["read_file", "respond"])
		assert.equal(children[0].params.executionProfile, "tasklet")
		assert.equal(children[0].params.taskId, id)
		assert.equal(cards[0].status, CardStatus.SUCCESS)
		sinon.assert.notCalled(children[0].task.retirePersistence)
	})

	it("accepts multiple assignments without joining them and publicly supervises only the selected child", async () => {
		const result = await spawn([
			{ task_title: "First child", prompt: "Investigate first" },
			{ task_title: "Second child", prompt: "Investigate second" },
		])
		const first = acceptedId(result)
		const sibling = acceptedId(result, 1)
		const selectedChild = children.find((child) => child.params.taskId === first)!
		const siblingChild = children.find((child) => child.params.taskId === sibling)!
		assert.notEqual(first, sibling)
		assert.equal((await call<TaskletInspection[]>({ operation: "list" })).length, 2)
		assert.equal((await inspect(first)).outcome, undefined)
		assert.equal((await inspect(sibling)).outcome, undefined)
		await call({ operation: "steer", tasklet_id: first, message: "Narrow the investigation" })
		sinon.assert.calledOnceWithExactly(selectedChild.task.enqueueSteeringMessage, "Narrow the investigation")
		sinon.assert.notCalled(siblingChild.task.enqueueSteeringMessage)
		const pending = registerInteraction(selectedChild, "spawned-question")
		await resolve(first, pending.requestId, "answer", { answer: "Use the current implementation" })
		assert.equal((await pending.waiting).text, "Use the current implementation")
		await call({ operation: "interrupt", tasklet_id: first, message: "Pause first only" })
		assert.equal((await inspect(first)).outcome?.kind, "interrupted")
		assert.equal((await inspect(sibling)).outcome, undefined)
		sinon.assert.notCalled(siblingChild.task.abortTask)
		assert.equal(cards.every((card) => card.status === CardStatus.SUCCESS), true)
	})

	it("retains accepted IDs across malformed assignments, option failures and a constructor startup failure", async () => {
		constructed.callsFake((params: TaskParams) => {
			if (params.task === "Constructor fails") throw new Error("Controlled startup failure")
			const child = controlledTask(params)
			children.push(child)
			return child.task
		})
		const result = await spawn([
			{ task_title: "Accepted child", prompt: "Keep investigating" },
			null,
			{ task_title: "Missing prompt" },
			{ task_title: "Bad timeout", prompt: "Do not start", timeout: 0 },
			{ task_title: "Failed startup", prompt: "Constructor fails" },
			{ task_title: "Accepted sibling", prompt: "Continue independently" },
		])
		assert.deepEqual(result.subagents.map(({ index }) => index), [0, 1, 2, 3, 4, 5])
		assert.deepEqual(result.subagents.map(({ accepted }) => accepted), [true, false, false, false, false, true])
		const first = acceptedId(result)
		const sibling = acceptedId(result, 5)
		assert.match(result.subagents[1].error!, /must be an object/)
		assert.match(result.subagents[2].error!, /prompt/)
		assert.match(result.subagents[3].error!, /[Tt]imeout/)
		assert.equal(result.subagents[1].id, undefined)
		assert.equal(result.subagents[4].error, "Controlled startup failure")
		const failed = result.subagents[4].id!
		assert.ok(isTaskletId(failed))
		assert.equal((await inspect(failed)).outcome?.kind, "failed")
		assert.equal((await inspect(failed)).outcomePersisted, true)
		assert.deepEqual(new Set(host.listActive().map(({ id }) => id)), new Set([first, sibling]))
		assert.equal((await loadTaskletRecords("root")).length, 3)
		assert.equal(cards[0].status, CardStatus.ERROR)
		sinon.assert.calledOnceWithExactly(cards[0].finalize, CardStatus.ERROR)
	})

	it("keeps spawned communication and full committed results addressable under the accepted ID", async () => {
		const id = acceptedId(await spawn([{ task_title: "Full result", prompt: "Return private detail" }]))
		const response = { operation: ResponseOperation.COMPLETE, text: fullText }
		await children[0].params.tasklet!.counterparty.recordResponse(response)
		assert.equal((await inspect(id)).outcome, undefined, "Completion communication is not a committed outcome")
		const delivery = await host.prepareEventDelivery()
		assert.ok(delivery)
		assert.match(delivery.content[0].text, new RegExp(id))
		assert.match(delivery.content[0].text, /preview truncated/)
		assert.equal(delivery.content[0].text.includes("END-OF-FULL-CONTENT"), false)
		await delivery.acknowledge()
		const events = await loadTaskletEvents(address(id))
		assert.equal(events[0].taskletId, id)
		assert.deepEqual(events[0].communication, { type: "response", response })
		children[0].outcome.resolve({ kind: "completed", response: fullText, completedAt: 123 })
		await call({ operation: "interrupt", tasklet_id: id })
		const stopped = await inspect(id)
		assert.equal(stopped.outcome?.kind, "completed")
		if (stopped.outcome?.kind !== "completed") assert.fail("Expected committed completion")
		assert.equal(stopped.outcome.response, fullText)
		assert.deepEqual(stopped.responses, [response])
		assert.equal((await loadTaskletRecords("root"))[0].id, id)
		assert.deepEqual(await call({ operation: "transcript", tasklet_id: id }), {
			conversation: children[0].conversation, presentation: children[0].presentation,
		})
	})

	it("projects running, waiting and terminal cards independently of spawn and reconciles restored same-ID state", async () => {
		await projectRoot()
		const result = await spawn([
			{ task_title: "Projected child", prompt: "Inspect projection" },
			{ task_title: "Projected sibling", prompt: "Continue independently" },
		])
		const id = acceptedId(result)
		const sibling = acceptedId(result, 1)
		const selectedChild = children.find((child) => child.params.taskId === id)!
		const siblingChild = children.find((child) => child.params.taskId === sibling)!
		await selectedChild.params.tasklet!.postStateToOwner()
		await siblingChild.params.tasklet!.postPresentationToOwner!()
		assert.equal(presentation(id).data.status, "running")
		assert.equal(presentation(sibling).data.status, "running")
		assert.equal(cards[0].status, CardStatus.SUCCESS)
		assert.deepEqual(await loadTaskletEvents(address(id)), [])
		const pending = registerInteraction(selectedChild, "projected-question")
		await host.prepareEventDelivery()
		const waiting = presentation(id)
		assert.equal(waiting.data.status, "waiting")
		assert.equal(waiting.card.status, CardStatus.WAITING_FOR_INPUT)
		assert.equal(waiting.card.requireApproval, undefined)
		assert.equal(waiting.card.requireFeedback, undefined)
		assert.equal(waiting.card.actions, undefined)
		assert.equal(presentation(sibling).data.status, "running")
		await resolve(id, pending.requestId, "answer", { answer: "Continue" })
		await pending.waiting
		assert.equal(presentation(id).data.status, "running")
		await selectedChild.params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: fullText })
		selectedChild.outcome.resolve({ kind: "completed", response: fullText, completedAt: 123 })
		await call({ operation: "interrupt", tasklet_id: id })
		assert.equal(presentation(id).data.status, "completed")
		assert.equal(presentation(id).card.status, CardStatus.SUCCESS)
		assert.ok(presentation(id).data.result!.length < fullText.length)
		assert.equal(presentation(id).data.result!.includes("END-OF-FULL-CONTENT"), false)
		assert.ok(presentation(id).data.activity.every((text) => text.length < fullText.length))
		await host.shutdown()
		await rootMessages!.saveDiracMessagesAndUpdateHistory()
		const saved = await getSavedPresentationHistory("root")
		assert.ok(saved.messages.some((message) => message.id === `tasklet:${id}`))
		rootMessages!.setDiracMessages(saved.messages, saved.lastOffset)
		host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		await host.reconstruct()
		await host.reconcileRootProjection()
		sinon.assert.calledTwice(constructed)
		assert.equal(presentation(id).data.status, "completed")
		assert.equal(presentation(sibling).data.status, "interrupted")
		assert.equal(rootMessages!.getDiracMessages().filter((message) => message.id === `tasklet:${id}`).length, 1)
		const resumed = await call<{ id: string }>({ operation: "resume", tasklet_id: id, message: "Continue the same conversation" })
		assert.equal(resumed.id, id)
		await children[2].params.tasklet!.postStateToOwner()
		assert.equal(presentation(id).data.status, "running")
		assert.equal(presentation(id).data.result, undefined)
		assert.equal(rootMessages!.getDiracMessages().filter((message) => message.id === `tasklet:${id}`).length, 1)
	})

	it("reports projection failure without changing a completed durable outcome or blocking same-ID resume", async () => {
		expectLoggerErrors()
		await projectRoot()
		const id = acceptedId(await spawn([{ task_title: "Display failure", prompt: "Finish independently of display" }]))
		await children[0].params.tasklet!.postStateToOwner()
		const project = owner.projectTasklet!
		const failure = new Error("Controlled tasklet display failure")
		const logged = sandbox.spy(Logger, "error")
		owner.projectTasklet = sandbox.stub().rejects(failure)
		const outcome: TaskRunOutcome = { kind: "completed", response: fullText, completedAt: 123 }
		children[0].outcome.resolve(outcome)
		const stopped = await call<TaskletInspection>({ operation: "interrupt", tasklet_id: id })
		assert.deepEqual(stopped.outcome, outcome)
		assert.equal(stopped.outcomePersisted, true)
		assert.equal(stopped.settlementError, undefined)
		assert.equal(stopped.presentationError?.message, failure.message)
		assert.deepEqual((await loadTaskletRecords("root"))[0].outcome, outcome)
		sinon.assert.calledWithExactly(logged, `[Tasklet ${id}] Presentation failed:`, failure)

		const resumed = await call<{ id: string }>({ operation: "resume", tasklet_id: id, message: "Continue after display failure" })
		assert.equal(resumed.id, id)
		sinon.assert.calledOnceWithExactly(children[1].task.resumeTaskFromHistory, undefined, { taskletResumeMessage: "Continue after display failure" })
		await children[1].params.tasklet!.postStateToOwner()
		const running = await inspect(id)
		assert.equal(running.outcome, undefined)
		assert.equal(running.outcomePersisted, false)
		assert.equal(running.settlementError, undefined)
		assert.equal(running.presentationError?.message, failure.message)
		owner.projectTasklet = project
		await children[1].params.tasklet!.postStateToOwner()
		assert.equal((await inspect(id)).presentationError, undefined)
		assert.equal(presentation(id).data.status, "running")
	})

	it("retains the public spawn ID and constructor failure when terminal projection also fails", async () => {
		expectLoggerErrors()
		await projectRoot()
		owner.projectTasklet = sandbox.stub().rejects(new Error("Controlled startup display failure"))
		constructed.throws(new Error("Controlled constructor failure"))
		const result = await spawn([{ task_title: "Failed construction", prompt: "Cannot construct" }])
		const entry = result.subagents[0]
		assert.equal(entry.accepted, false)
		assert.ok(isTaskletId(entry.id!))
		assert.equal(entry.error, "Controlled constructor failure")
		const snapshot = await inspect(entry.id!)
		assert.equal(snapshot.outcome?.kind, "failed")
		if (snapshot.outcome?.kind !== "failed") assert.fail("Expected constructor failure")
		assert.equal(snapshot.outcome.error.message, entry.error)
		assert.equal(snapshot.outcomePersisted, true)
		assert.equal(snapshot.settlementError, undefined)
		assert.equal(snapshot.presentationError?.message, "Controlled startup display failure")
		assert.deepEqual((await loadTaskletRecords("root"))[0].outcome, snapshot.outcome)
		assert.deepEqual(host.listActive(), [])
		assert.equal(cards[0].status, CardStatus.ERROR)
	})

	it("persists event resolution and retirement despite projection failures without unhandled rejections", async () => {
		expectLoggerErrors()
		await projectRoot()
		const id = acceptedId(await spawn([{ task_title: "Communication display failure", prompt: "Ask twice" }]))
		await children[0].params.tasklet!.postStateToOwner()
		owner.projectTasklet = sandbox.stub().rejects(new Error("Controlled event display failure"))
		const unhandled: unknown[] = []
		const collectUnhandled = (error: unknown) => { unhandled.push(error) }
		process.on("unhandledRejection", collectUnhandled)
		try {
			await children[0].params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "Durable progress" })
			const answered = registerInteraction(children[0], "answered-despite-display")
			assert.deepEqual(await resolve(id, answered.requestId, "answer", { answer: "Continue" }), { status: "resolved" })
			assert.equal((await answered.waiting).text, "Continue")
			const retired = registerInteraction(children[0], "retired-despite-display")
			const stopped = await call<TaskletInspection>({ operation: "interrupt", tasklet_id: id })
			await assert.rejects(retired.waiting, /retired/)
			assert.equal(stopped.outcome?.kind, "interrupted")
			assert.equal(stopped.outcomePersisted, true)
			assert.equal(stopped.settlementError, undefined)
			assert.equal(stopped.presentationError?.message, "Controlled event display failure")
			const events = await loadTaskletEvents(address(id))
			assert.equal(events.length, 4)
			assert.deepEqual(events[3].communication, { type: "outcome", outcome: stopped.outcome })
			assert.deepEqual(events[0].communication, { type: "response", response: { operation: ResponseOperation.PROGRESS, text: "Durable progress" } })
			const interactions = events.flatMap((event) => event.communication.type === "interaction" ? [event.communication.request] : [])
			assert.deepEqual(interactions.map(({ id, status }) => ({ id, status })), [
				{ id: answered.requestId, status: "resolved" }, { id: retired.requestId, status: "retired" },
			])
			await host.shutdown()
			await new Promise<void>((resolve) => setImmediate(resolve))
			assert.deepEqual(unhandled, [])
		} finally {
			process.off("unhandledRejection", collectUnhandled)
		}
	})

	/** Integrated cutover acceptance: real dispatch/host/storage, controlled child engines and usage snapshots; no live provider or UI. */
	it("composes generic/named startup, parent supervision and durable same-ID reopening without truncating results or double accounting", async () => {
		await projectRoot()
		constructed.callsFake((params: TaskParams) => {
			if (params.task === "Constructor fails") throw new Error("Controlled startup failure")
			const child = controlledTask(params)
			children.push(child)
			return child.task
		})
		const batch = await spawn([
			{ task_title: "Question child", prompt: "Ask before proceeding" },
			null,
			{ task_title: "Failed startup", prompt: "Constructor fails" },
			{ task_title: "Independent sibling", prompt: "Keep making progress" },
		])
		assert.deepEqual(batch.subagents.map(({ accepted }) => accepted), [true, false, false, true])
		assert.match(batch.subagents[1].error!, /must be an object/)
		const failedId = batch.subagents[2].id!
		assert.ok(isTaskletId(failedId))
		assert.equal(batch.subagents[2].error, "Controlled startup failure")
		assert.equal((await inspect(failedId)).outcome?.kind, "failed")
		const questionId = acceptedId(batch)
		const siblingId = acceptedId(batch, 3)
		const namedId = acceptedId(await spawn([{ task_title: "Named permission", prompt: "Request parent permission" }], "subagent_research"))
		const child = (id: string) => [...children].reverse().find((entry) => entry.params.taskId === id)!
		assert.equal(cards[0].status, CardStatus.ERROR)
		assert.equal(cards[1].status, CardStatus.SUCCESS)
		assert.equal(children.length, 3)
		for (const id of [questionId, siblingId, namedId]) {
			assert.equal((await inspect(id)).outcome, undefined, "Both spawn interfaces return before controlled execution finishes")
			sinon.assert.notCalled(child(id).task.retirePersistence)
		}
		assert.equal((await inspect(namedId)).configuration?.name, "Research")

		const question = registerInteraction(child(questionId), "composed-question")
		const permission = registerInteraction(child(namedId), "composed-permission", true)
		await resolve(questionId, question.requestId, "answer", { answer: "Use the current implementation" })
		assert.equal((await question.waiting).text, "Use the current implementation")
		sinon.assert.notCalled(owner.authorizePermission)
		assert.deepEqual(await resolve(namedId, permission.requestId, "approve"), { status: "requires_user_approval" })
		const entered = deferred<void>()
		const user = deferred<typeof approved>()
		owner.escalateInteraction.callsFake(() => { entered.resolve(); return user.promise })
		const escalating = resolve(namedId, permission.requestId, "escalate")
		await entered.promise
		assert.equal((await inspect(namedId)).interactions[0].status, "pending")
		assert.deepEqual(owner.escalateInteraction.firstCall.args[0], { id: namedId, title: "Named permission" })
		const sleeping = call<TaskletWakeResult>({ operation: "sleep", tasklet_ids: [siblingId] })
		await inspect(siblingId) // Ensure the public sleep dispatch has registered its waiter.
		assert.equal(host.isSleeping, true)
		await child(siblingId).params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "Sibling progresses during escalation" })
		const wake = await sleeping
		assert.equal(wake.reason, "event")
		if (wake.reason !== "event") assert.fail("Expected sibling communication")
		assert.equal(wake.taskletId, siblingId)
		assert.equal((await inspect(namedId)).interactions[0].status, "pending")
		assert.equal((await inspect(siblingId)).outcome, undefined)
		user.resolve(approved)
		assert.deepEqual(await escalating, { status: "resolved" })
		assert.deepEqual(await permission.waiting, approved)
		sinon.assert.calledTwice(owner.assertPermissionAllowed)

		const usage: TaskletUsageSnapshot = {
			primary: { tokensIn: 100, tokensOut: 20, cost: 1, reasoningTokens: 3 },
			utility: { tokensIn: 10, tokensOut: 2, cost: 0.25, reasoningTokens: 1 },
		}
		const expectedUsage = new Map([[questionId, usage], [namedId, usage]])
		function recordUsage(id: string, snapshot: TaskletUsageSnapshot) {
			child(id).params.tasklet!.recordUsage!(snapshot)
			child(id).params.tasklet!.recordUsage!(snapshot)
		}
		async function assertAccounting() {
			const messages = rootMessages!.getDiracMessages()
			const contributions = messages.flatMap((message) => message.content.type === DiracMessageType.CARD
				? [getTaskletUsage(message.content.card)].filter((entry) => entry !== undefined) : [])
			assert.deepEqual(contributions.map(({ taskletId }) => taskletId).sort(), [...expectedUsage.keys()].sort())
			const totals = [...expectedUsage.values()].map(taskletUsageTotal)
			const metrics = getApiMetrics(messages)
			assert.equal(metrics.totalTokensIn, totals.reduce((sum, value) => sum + value.tokensIn, 0))
			assert.equal(metrics.totalTokensOut, totals.reduce((sum, value) => sum + value.tokensOut, 0))
			assert.equal(metrics.totalCost, totals.reduce((sum, value) => sum + value.cost, 0))
			assert.equal(metrics.totalReasoningTokens, totals.reduce((sum, value) => sum + value.reasoningTokens, 0))
			const records = await loadTaskletRecords("root")
			for (const [id, snapshot] of expectedUsage) {
				assert.deepEqual(records.find((record) => record.id === id)!.usage, snapshot, "Durable primary/Utility split is retained")
				assert.deepEqual(contributions.find((entry) => entry.taskletId === id), { source: "tasklet", taskletId: id, ...taskletUsageTotal(snapshot) })
			}
		}
		for (const id of expectedUsage.keys()) recordUsage(id, usage)
		await child(namedId).params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.COMPLETE, text: fullText })
		child(namedId).outcome.resolve({ kind: "completed", response: fullText, completedAt: 123 })
		// Join controlled settlement through a public control; spawn itself never joins.
		assert.equal((await call<TaskletInspection>({ operation: "interrupt", tasklet_id: namedId })).outcome?.kind, "completed")
		const delivery = await host.prepareEventDelivery()
		assert.ok(delivery)
		const preview = delivery.content.map(({ text }) => text).join("\n")
		assert.match(preview, /preview truncated/)
		assert.equal(preview.includes("END-OF-FULL-CONTENT"), false)
		assert.equal(presentation(namedId).data.result!.includes("END-OF-FULL-CONTENT"), false)
		await delivery.acknowledge()
		const interrupted = await call<TaskletInspection>({ operation: "interrupt", tasklet_id: questionId, message: "Pause only this child" })
		assert.equal(interrupted.outcome?.kind, "interrupted")
		sinon.assert.notCalled(child(siblingId).task.abortTask)
		assert.equal((await inspect(siblingId)).outcome, undefined)
		await assertAccounting()
		const identities = new Map((await call<TaskletInspection[]>({ operation: "list" })).map((record) => [record.id, record.conversationUlid]))

		async function reconstructRoot() {
			await host.shutdown()
			await rootMessages!.saveDiracMessagesAndUpdateHistory()
			await rootMessages!.retirePersistence()
			const saved = await getSavedPresentationHistory("root")
			rootMessages = new MessageStateHandler({
				taskId: "root", ulid: "root-conversation", taskState: new TaskState(), updateTaskHistory: async () => [],
			})
			rootMessages.setDiracMessages(saved.messages, saved.lastOffset)
			host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
			await host.reconstruct()
			await host.reconcileRootProjection()
			await host.reconcileRootProjection() // Reconciliation replaces contributions, never adds another charge.
			await assertAccounting()
		}
		await reconstructRoot()
		assert.equal(children.length, 3, "History restoration starts no child engines")
		assert.equal((await inspect(siblingId)).outcome?.kind, "interrupted", "Root shutdown settles the still-active sibling")
		assert.equal((await inspect(questionId)).outcome?.kind, "interrupted")
		const completed = await inspect(namedId)
		assert.deepEqual(completed.outcome, { kind: "completed", response: fullText, completedAt: 123 })
		assert.equal(completed.responses.at(-1)!.text, fullText)
		const transcript = await call<TaskletTranscript>({ operation: "transcript", tasklet_id: namedId })
		assert.deepEqual(transcript, { conversation: child(namedId).conversation, presentation: child(namedId).presentation })

		const increased: TaskletUsageSnapshot = {
			primary: { tokensIn: 150, tokensOut: 30, cost: 1.5, reasoningTokens: 5 },
			utility: { tokensIn: 30, tokensOut: 6, cost: 0.75, reasoningTokens: 2 },
		}
		for (const id of [questionId, namedId]) {
			const resumed = await call<TaskletInspection>({ operation: "resume", tasklet_id: id, message: "Explicit follow-up" })
			assert.equal(resumed.id, id)
			assert.equal(resumed.conversationUlid, identities.get(id))
			assert.equal(resumed.outcome, undefined)
			assert.deepEqual(child(id).params.tasklet!.usage, usage, "Reopened engine receives lifetime primary/Utility baseline")
			sinon.assert.notCalled(child(id).task.startTask)
			sinon.assert.calledOnceWithExactly(child(id).task.resumeTaskFromHistory, undefined, { taskletResumeMessage: "Explicit follow-up" })
			if (id === namedId) assert.equal((await inspect(id)).configuration?.name, "Research")
			recordUsage(id, usage) // Re-reporting restored lifetime usage is not new spend.
			await assertAccounting()
			recordUsage(id, increased) // Controlled engine reports cumulative lifetime usage, not a per-run delta.
			expectedUsage.set(id, increased)
			child(id).outcome.resolve({ kind: "completed", response: fullText, completedAt: 125 })
			assert.equal((await call<TaskletInspection>({ operation: "interrupt", tasklet_id: id })).outcome?.kind, "completed")
			await assertAccounting()
		}
		await reconstructRoot()
		assert.equal(children.length, 5, "A second restoration does not replay explicitly reopened runs")
		const retained = await call<TaskletInspection[]>({ operation: "list" })
		assert.deepEqual(new Map(retained.map((record) => [record.id, record.conversationUlid])), identities)
		for (const record of retained) {
			assert.equal(record.conversationUlid, identities.get(record.id))
			assert.equal(record.outcomePersisted, true)
		}
		assert.deepEqual(await call({ operation: "transcript", tasklet_id: namedId }), transcript)
	})

	it("accounts public spawn usage only through replaceable host snapshots, not the former batch result path", async () => {
		await projectRoot()
		const id = acceptedId(await spawn([{ task_title: "Account once", prompt: "Use primary and Utility" }]))
		const usage: TaskletUsageSnapshot = {
			primary: { tokensIn: 100, tokensOut: 20, cost: 1, reasoningTokens: 3 },
			utility: { tokensIn: 10, tokensOut: 2, cost: 0.25, reasoningTokens: 1 },
		}
		children[0].params.tasklet!.recordUsage!(usage)
		children[0].params.tasklet!.recordUsage!(usage)
		children[0].outcome.resolve({ kind: "completed", response: "Done", completedAt: 123 })
		await call({ operation: "interrupt", tasklet_id: id })
		const messages = rootMessages!.getDiracMessages()
		const accounting = messages.flatMap((message) => message.content.type === DiracMessageType.CARD && getTaskletUsage(message.content.card) ? [message] : [])
		assert.deepEqual(accounting.map(({ id }) => id), [`tasklet-usage:${id}`])
		assert.equal(getApiMetrics(messages).totalCost, 1.25)
		assert.equal(getApiMetrics(messages).totalTokensIn, 110)
		assert.equal(getApiMetrics(messages).totalReasoningTokens, 4)
		assert.deepEqual(presentation(id).data.usage, taskletUsageTotal(usage))
		assert.equal(presentation(id).card.rawOutput?.source, undefined)
		assert.equal(cards.some((card) => card.rawOutput?.source === "subagents" || card.rawOutput?.source === "tasklet"), false)
		assert.deepEqual((await loadTaskletRecords("root"))[0].usage, usage)
	})

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

	it("wakes public unbounded sleep for a silent failed outcome and retains its notification until acknowledgement", async () => {
		const id = acceptedId(await spawn([{ task_title: "Silent failure", prompt: "Work without a response" }]))
		const sleeping = call<TaskletWakeResult>({ operation: "sleep", tasklet_ids: [id] })
		await inspect(id) // The later dispatch proves the public sleeper is registered.
		assert.equal(host.isSleeping, true)
		const outcome: TaskRunOutcome = { kind: "failed", failedAt: 130, error: { name: "Error", message: "Provider stopped silently" } }
		children[0].outcome.resolve(outcome)
		await host["children"].get(id)!.settlement
		const events = await loadTaskletEvents(address(id))
		assert.equal(events.length, 1)
		assert.deepEqual(events[0].communication, { type: "outcome", outcome })
		const wake = { reason: "event", taskletId: id, eventId: events[0].id }
		assert.deepEqual(await sleeping, wake)
		assert.deepEqual(await call({ operation: "sleep", tasklet_ids: [id] }), wake)
		const snapshot = await inspect(id)
		assert.deepEqual(snapshot.outcome, outcome)
		assert.equal(snapshot.outcomePersisted, true)
		assert.deepEqual(snapshot.responses, [], "The host notification must not fabricate an agent response")
		const delivery = (await host.prepareEventDelivery())!
		assert.equal(delivery.content.length, 1)
		assert.deepEqual(delivery.content[0].taskletEventIds, [events[0].id])
		assert.match(delivery.content[0].text, /"type":"outcome"/)
		await delivery.acknowledge()
		const acknowledged = await loadTaskletEvents(address(id))
		assert.equal(acknowledged.length, 1)
		assert.equal(typeof acknowledged[0].deliveredAt, "number")
		assert.equal(await host.prepareEventDelivery(), undefined)
		const nextSleep = call({ operation: "sleep", tasklet_ids: [id] })
		await inspect(id)
		assert.equal(host.isSleeping, true)
		host.notifyUserMessage()
		assert.deepEqual(await nextSleep, { reason: "user_message" })
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
