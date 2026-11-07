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
import { loadTaskletEvents, loadTaskletRecords, saveTaskletEvents } from "@core/storage/taskStorage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { isTaskletId } from "@shared/taskletId"
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
import type { ICardHandle, TaskletControls, TaskletWakeResult } from "../tools/interfaces/IToolEnvironment"
import type { ToolExecutionEnvironment } from "../tools/interfaces/ToolEnvironmentFactory"
import { create, createSecondary } from "../tools/modules/use_subagents/tool"
import { AgentConfigLoader } from "../tools/subagent/AgentConfigLoader"

import { summarizeTasklet } from "../TaskletInspection"
import type { TaskletInspectionPage, TaskletMessageResult, TaskletSummary } from "../types/tasklet"
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((res) => {
		resolve = res
	})
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
		postTaskletActivity: sinon.SinonStub
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
		const presentation: DiracMessage[] = [
			{
				id: "child-text",
				ts: 1,
				content: { type: DiracMessageType.MARKDOWN, content: fullText },
			},
		]
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
				getPresentationOffset: () => 0,
				getPresentationStateGeneration: () => 0,
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
			getCachedConfig: (name: string) =>
				name === "Research"
					? {
						name: "Research",
						description: "Research assignment",
						systemPrompt: "Investigate independently",
						tools: ["read_file"],
					}
					: undefined,
			resolveSubagentNameForTool: (name: string) => (name === "subagent_research" ? "Research" : undefined),
			isDynamicSubagentTool: (name: string) => name === "subagent_research",
		} as unknown as AgentConfigLoader)
		constructed = sandbox.stub().callsFake((params: TaskParams) => {
			const child = controlledTask(params)
			children.push(child)
			return child.task
		})
		owner = {
			taskId: "root",
			executionProfile: "standalone",
			authorizePermission: sandbox.stub().resolves({ approved: false, assertCurrent: () => { } }),
			assertPermissionAllowed: sandbox.stub(),
			escalateInteraction: sandbox.stub().resolves(rejected),
			hasPendingUserInput: sandbox.stub().returns(false),
			postTaskletActivity: sandbox.stub().resolves(),
			withMutationAuthorization: (_toolName, mutation) => mutation(),
			retainMutationUntil: () => { },
		}
		options = {
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
		host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		const controls: TaskletControls = {
			start: (input) => host.start(input),
			list: (query) => host.listSummaries(query),
			inspect: (id, query) => host.query(id, query),
			message: (items) => host.message(items),
			interrupt: async (id, reason) => summarizeTasklet(await host.interrupt(id, reason)),
			resume: (id, message) => host.resume(id, message),
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
								...params,
								id: `control-card-${cards.length}`,
								status: CardStatus.RUNNING,
								update: sandbox.stub().callsFake(async (patch) => {
									Object.assign(card, patch)
								}),
								finalize: sandbox.stub().callsFake(async (status) => {
									Object.assign(card, { status })
								}),
							} as unknown as (typeof cards)[number]
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
		const page = await call<TaskletInspectionPage<TaskletSummary>>({ operation: "inspect", tasklet_id: id })
		return page.items[0]
	}

	function request(cardId: string, permission = false): TaskInteractionRequest {
		return {
			card: {
				id: cardId,
				kind: CardKind.GENERIC,
				header: permission ? "Permission" : "Question",
				body: fullText,
				status: CardStatus.WAITING_FOR_INPUT,
				renderType: "text",
				...(permission ? { requireApproval: true } : { requireFeedback: true }),
			},
			...(permission
				? {
					permissionRequestKind: "manual_tool" as const,
					permissionOperation: { kind: "commands" as const, commands: ["echo private"] },
					toolCall: { name: "execute_command", arguments: { commands: ["echo private"] } },
				}
				: {}),
		}
	}

	function registerInteraction(child: ReturnType<typeof controlledTask>, cardId: string, permission = false) {
		const cancellation = new AbortController()
		const waiting = child.params.tasklet!.counterparty.requestInteraction(request(cardId, permission), cancellation.signal)
		void waiting.catch(() => { }) // Retirement assertions own the original rejection.
		const requestId = host.inspect(child.params.taskId!).interactions.at(-1)!.id
		return { waiting, cancellation, requestId }
	}

	async function message(taskletId: string, item: Record<string, unknown>): Promise<TaskletMessageResult> {
		return (await call<TaskletMessageResult[]>({ operation: "message", messages: [{ tasklet_id: taskletId, ...item }] }))[0]
	}

	async function acknowledgeEvents() {
		let delivery = await host.prepareEventDelivery()
		while (delivery) {
			await delivery.acknowledge()
			delivery = await host.prepareEventDelivery()
		}
	}

	interface SpawnResult {
		subagents: Array<{
			index: number
			id?: string
			title?: string
			accepted: boolean
			error?: string
			outcome?: TaskRunOutcome
		}>
	}

	async function spawn(assignments: unknown[], toolName = "use_subagents"): Promise<SpawnResult> {
		const params = toolName === "use_subagents" ? { subagents: assignments } : (assignments[0] as Record<string, unknown>)
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
			taskId: "root",
			ulid: "root-conversation",
			taskState: new TaskState(),
			updateTaskHistory: async () => [],
		})
		await rootMessages.addToDiracMessages({
			id: "root-user",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Parent assignment" },
		})
		owner.recordTaskletUsage = (id, usage) => rootMessages!.upsertTaskletUsage(id, taskletUsageTotal(usage))
	}


	it("returns generic and named acceptance without joining, and always constructs Act children", async () => {
		for (const toolName of ["use_subagents", "subagent_research"]) {
			const id = acceptedId(await spawn([{ task_title: "Trace startup", prompt: "Investigate startup" }], toolName))
			assert.equal((await inspect(id)).outcome, undefined)
			const child = children.at(-1)!
			assert.equal(child.params.workingConfiguration!.settings.mode, "act")
			assert.equal(child.params.executionProfile, "tasklet")
			sinon.assert.calledOnceWithExactly(child.task.startTask, "Investigate startup")
			sinon.assert.notCalled(child.task.retirePersistence)
			assert.equal(cards.at(-1)!.status, CardStatus.SUCCESS)
			if (toolName !== "use_subagents") assert.equal(host.inspect(id).configuration?.name, "Research")
		}
		assert.equal(host.listActive().length, 2)
	})

	it("retains accepted IDs and independent siblings across malformed input and constructor failure", async () => {
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
			{ task_title: "Sibling", prompt: "Continue" },
		])
		assert.deepEqual(
			result.subagents.map(({ accepted }) => accepted),
			[true, false, false, false, false, true],
		)
		assert.deepEqual(
			result.subagents.map(({ index }) => index),
			[0, 1, 2, 3, 4, 5],
		)
		assert.ok(isTaskletId(result.subagents[4].id!))
		assert.equal((await inspect(result.subagents[4].id!)).outcome?.kind, "failed")
		assert.equal((await loadTaskletRecords("root")).length, 3)
		assert.equal(host.listActive().length, 2)
		assert.equal(cards[0].status, CardStatus.ERROR)
	})

	it("returns compact inventory/status and exact selected evidence without inherited history or presentation", async () => {
		options.getParentHistory = () => ({ messages: [{ role: "user", content: "INHERITED_PARENT_SECRET" }] })
		const id = acceptedId(await spawn([{ task_title: "Evidence", prompt: "Inspect", include_history: true }]))
		const child = children[0]
		child.conversation.unshift({ role: "user", content: "INHERITED_PARENT_SECRET" })
		child.conversation.push(
			{
				role: "assistant",
				ts: 2,
				content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "private.md" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: fullText }] },
		)
		await child.params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: fullText })
		registerInteraction(child, "question")
		const before = await loadTaskletEvents(address(id))
		const listed = await call<TaskletInspectionPage<TaskletSummary>>({ operation: "list" })
		assert.equal(listed.totalItems, 1)
		assert.equal(listed.items[0].pendingRequestCount, 1)
		assert.ok(listed.items[0].deadlineAt! > Date.now())
		assert.ok(!JSON.stringify(listed).includes("END-OF-FULL-CONTENT"))
		assert.equal("responses" in listed.items[0], false)
		assert.equal("interactions" in listed.items[0], false)
		const trajectory = await call({ operation: "inspect", tasklet_id: id, view: "trajectory" })
		assert.match(JSON.stringify(trajectory), /call-1/)
		assert.ok(!JSON.stringify(trajectory).includes("END-OF-FULL-CONTENT"))
		const result = await call({ operation: "inspect", tasklet_id: id, view: "result", call_id: "call-1" })
		assert.match(JSON.stringify(result), /END-OF-FULL-CONTENT/)
		const transcript = await call<TaskletInspectionPage>({ operation: "inspect", tasklet_id: id, view: "transcript" })
		assert.ok(!JSON.stringify(transcript).includes("INHERITED_PARENT_SECRET"))
		assert.equal("presentation" in transcript, false)
		assert.deepEqual(await loadTaskletEvents(address(id)), before, "Passive queries never acknowledge events")
		sinon.assert.notCalled(child.task.enqueueSteeringMessage)
		sinon.assert.calledOnce(constructed)
		assert.match(cards.at(-1)!.header, /Evidence.*transcript/)
	})

	it("publishes only committed outcomes and recovers the record/event crash gap without duplication", async () => {
		const id = acceptedId(await spawn([{ task_title: "Committed result", prompt: "Inspect" }]))
		await assert.rejects(
			children[0].params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.COMPLETE, text: fullText }),
			/Only progress/,
		)
		assert.equal((await inspect(id)).outcome, undefined)
		const outcome: TaskRunOutcome = { kind: "completed", response: fullText, completedAt: 123 }
		children[0].outcome.resolve(outcome)
		await call({ operation: "interrupt", tasklet_id: id })
		const assignment = await call<TaskletInspectionPage<{ outcome: TaskRunOutcome }>>({
			operation: "inspect",
			tasklet_id: id,
			view: "assignment",
		})
		assert.deepEqual(assignment.items[0].outcome, outcome)
		await host.shutdown()
		const events = await loadTaskletEvents(address(id))
		await saveTaskletEvents(
			address(id),
			events.filter((event) => event.communication.type !== "outcome"),
		)
		host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		await host.reconstruct()
		assert.equal((await inspect(id)).outcome?.kind, "completed")
		const repaired = await loadTaskletEvents(address(id))
		assert.equal(repaired.filter((event) => event.communication.type === "outcome").length, 1)
		host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		await host.reconstruct()
		assert.deepEqual(await loadTaskletEvents(address(id)), repaired)
		sinon.assert.calledOnce(constructed)
	})

	it("records correlated questions before delivery and never treats queued guidance as an answer", async () => {
		const id = acceptedId(await spawn([{ task_title: "Waiting child", prompt: "Ask" }]))
		const pending = registerInteraction(children[0], "question")
		const question = await message(id, { type: "question", text: "Why that approach?" })
		assert.equal(question.status, "queued")
		assert.equal(
			(await loadTaskletEvents(address(id))).find((event) => event.id === question.messageId)?.deliveredAt,
			undefined,
			"Parent-to-child acceptance must not fabricate a parent-input delivery receipt",
		)
		assert.match(children[0].task.enqueueSteeringMessage.firstCall.args[0], new RegExp(question.messageId!))
		await children[0].params.tasklet!.counterparty.recordResponse({
			operation: ResponseOperation.PROGRESS,
			text: "Because it preserves ownership",
			reply_to: question.messageId,
		})
		await assert.rejects(
			children[0].params.tasklet!.counterparty.recordResponse({
				operation: ResponseOperation.PROGRESS,
				text: "Wrong recipient",
				reply_to: "unknown",
			}),
			/does not address/,
		)
		assert.equal(host.inspect(id).interactions[0].status, "pending")
		const guidance = await message(id, { type: "guidance", text: "Narrow the investigation" })
		assert.equal(guidance.status, "queued")
		assert.match(cards.at(-1)!.body!, /Narrow the investigation.*\nOutcome: queued/)
		assert.ok(!cards.at(-1)!.header.includes(id))
		const replies = await call<TaskletInspectionPage>({
			operation: "inspect",
			tasklet_id: id,
			view: "messages",
			message_type: "reply",
		})
		assert.equal(replies.totalItems, 1)
		assert.equal(
			(await message(id, { type: "reply", reply_to: pending.requestId, text: "Explicit answer" })).status,
			"resolved",
		)
		assert.equal((await pending.waiting).text, "Explicit answer")
	})

	it("prevalidates the whole batch and reports independent partial success with idempotent retries", async () => {
		const first = await host.start({ title: "First", prompt: "Ask" })
		const sibling = await host.start({ title: "Sibling", prompt: "Ask" })
		const question = registerInteraction(children[0], "question")
		const permission = registerInteraction(children[1], "permission", true)
		const reply = { tasklet_id: first.id, type: "reply", reply_to: question.requestId, text: "Continue" }
		assert.match(
			await dispatch({ operation: "message", messages: [reply, { ...reply, text: "Conflicting" }] }),
			/Duplicate or conflicting/,
		)
		assert.equal(host.inspect(first.id).interactions[0].status, "pending")
		const result = await call<TaskletMessageResult[]>({
			operation: "message",
			messages: [
				reply,
				{ tasklet_id: sibling.id, type: "permission_decision", reply_to: permission.requestId, decision: "approve" },
				{ tasklet_id: "not-owned", type: "reply", reply_to: "not-a-request", text: "No" },
			],
		})
		assert.deepEqual(
			result.map(({ status }) => status),
			["resolved", "requires_user_approval", "stale"],
		)
		assert.equal((await question.waiting).text, "Continue")
		assert.equal(host.inspect(sibling.id).interactions[0].status, "pending")
		assert.equal(cards.at(-1)!.status, CardStatus.ERROR)
		assert.match(cards.at(-1)!.body!, /requires_user_approval/)
		assert.equal(
			(await message(first.id, { type: "reply", reply_to: question.requestId, text: "Continue" })).status,
			"already_resolved",
		)
		assert.equal(
			(await message(first.id, { type: "reply", reply_to: question.requestId, text: "Different" })).status,
			"failed",
		)
		assert.equal(
			(await message(sibling.id, { type: "permission_decision", reply_to: permission.requestId, decision: "reject" }))
				.status,
			"resolved",
		)
		assert.deepEqual(await permission.waiting, rejected)
	})

	it("keeps prose answers and invented choices separate from permission grants", async () => {
		const { id } = await host.start({ title: "Permission", prompt: "Ask" })
		const permission = registerInteraction(children[0], "permission", true)
		assert.equal((await message(id, { type: "reply", reply_to: permission.requestId, text: "approved" })).status, "failed")
		assert.equal(host.inspect(id).interactions[0].status, "pending")
		const question = registerInteraction(children[0], "question")
		assert.equal(
			(await message(id, { type: "permission_decision", reply_to: question.requestId, decision: "approve" })).status,
			"failed",
		)
		assert.equal(
			(await message(id, { type: "reply", reply_to: question.requestId, action: "invented-choice" })).status,
			"failed",
		)
		sinon.assert.notCalled(owner.authorizePermission)
	})

	it("rechecks parent authority after an asynchronous decision and leaves a refused request pending", async () => {
		const { id } = await host.start({ title: "Permission", prompt: "Work" })
		const permission = registerInteraction(children[0], "permission", true)
		assert.equal(
			(await message(id, { type: "permission_decision", reply_to: permission.requestId, decision: "approve" })).status,
			"requires_user_approval",
		)
		sinon.assert.notCalled(owner.escalateInteraction)
		const entered = deferred<void>()
		const authority = deferred<{ approved: boolean; assertCurrent: () => void }>()
		owner.authorizePermission.callsFake(() => {
			entered.resolve()
			return authority.promise
		})
		const deciding = message(id, { type: "permission_decision", reply_to: permission.requestId, decision: "approve" })
		await entered.promise
		authority.resolve({
			approved: true,
			assertCurrent: () => {
				throw new Error("Parent authority changed")
			},
		})
		assert.match((await deciding).error!, /Parent authority changed/)
		assert.equal(host.inspect(id).interactions[0].status, "pending")
		const assertCurrent = sandbox.stub()
		owner.authorizePermission.resolves({ approved: true, assertCurrent })
		assert.equal(
			(await message(id, { type: "permission_decision", reply_to: permission.requestId, decision: "approve" })).status,
			"resolved",
		)
		assert.deepEqual(await permission.waiting, approved)
		sinon.assert.calledTwice(assertCurrent)
	})

	it("escalates only the exact pending request and preserves concurrent sibling progress", async () => {
		const { id } = await host.start({ title: "Escalation", prompt: "Work" })
		const sibling = await host.start({ title: "Sibling", prompt: "Work" })
		const permission = registerInteraction(children[0], "permission", true)
		await acknowledgeEvents()
		const entered = deferred<void>()
		const user = deferred<typeof approved>()
		owner.escalateInteraction.callsFake(() => {
			entered.resolve()
			return user.promise
		})
		const resolving = message(id, { type: "permission_decision", reply_to: permission.requestId, decision: "escalate" })
		await entered.promise
		assert.equal(host.inspect(id).interactions[0].status, "pending")
		assert.deepEqual(owner.escalateInteraction.firstCall.args[0], { id, title: "Escalation" })
		const sleeping = call<TaskletWakeResult>({ operation: "sleep", tasklet_ids: [sibling.id] })
		await inspect(sibling.id)
		assert.equal(host.isSleeping, true)
		await children[1].params.tasklet!.counterparty.recordResponse({
			operation: ResponseOperation.PROGRESS,
			text: "Sibling progresses",
		})
		assert.equal((await sleeping).reason, "event")
		user.resolve(approved)
		assert.equal((await resolving).status, "resolved")
		assert.deepEqual(await permission.waiting, approved)
		sinon.assert.calledTwice(owner.assertPermissionAllowed)
		sinon.assert.notCalled(owner.authorizePermission)
	})

	it("retires old request identities and requires explicit same-conversation Act resumption", async () => {
		const record = await host.start({ title: "Retirement", prompt: "Ask" })
		const sibling = await host.start({ title: "Sibling", prompt: "Keep working" })
		const pending = registerInteraction(children[0], "question")
		await call({ operation: "interrupt", tasklet_id: record.id, message: "Pause only this child" })
		await assert.rejects(pending.waiting, /retired/)
		assert.equal((await inspect(sibling.id)).outcome, undefined)
		sinon.assert.notCalled(children[1].task.abortTask)
		assert.equal((await message(record.id, { type: "guidance", text: "Not a resume" })).status, "failed")
		const resumed = await call<{ id: string; accepted: boolean }>({
			operation: "resume",
			tasklet_id: record.id,
			message: "Explicit follow-up",
		})
		assert.equal(resumed.id, record.id)
		assert.equal(resumed.accepted, true)
		assert.equal(host.inspect(record.id).conversationUlid, record.conversationUlid)
		assert.equal(children[2].params.workingConfiguration!.settings.mode, "act")
		assert.equal((await message(record.id, { type: "reply", reply_to: pending.requestId, text: "Too late" })).status, "stale")
		const fresh = registerInteraction(children[2], "question")
		assert.notEqual(fresh.requestId, pending.requestId)
		assert.equal(
			(await message(record.id, { type: "reply", reply_to: fresh.requestId, text: "Current answer" })).status,
			"resolved",
		)
		assert.equal((await fresh.waiting).text, "Current answer")
		const lifecycle = (await loadTaskletEvents(address(record.id))).filter(
			(event) => event.communication.type === "lifecycle",
		)
		assert.equal(lifecycle.length, 2)
	})

	it("observes sixteen independent tasklets without publishing trajectories into parent history", async () => {
		await projectRoot()
		const { id } = await host.start({ title: "Child 0", prompt: "Work" })
		await Promise.all(Array.from({ length: 15 }, (_, index) => host.start({ title: `Child ${index + 1}`, prompt: "Work" })))
		const sourceId = host.observationSourceId
		const readPresentation = sandbox.spy(children[0].task.messageStateHandler, "getDiracMessages")
		const fullInspection = sandbox.spy(host, "inspect")
		const publications = owner.postTaskletActivity.callCount
		assert.equal(publications, 16)
		assert.deepEqual(host.observationSummary(), { rootTaskId: "root", sourceId, availability: "live", activeCount: 16 })
		assert.equal(host.observationInventory("active").length, 16)
		sinon.assert.notCalled(readPresentation)
		sinon.assert.notCalled(fullInspection)
		await children[0].params.tasklet!.postStateToOwner()
		await children[0].params.tasklet!.postPresentationToOwner!()
		assert.equal(owner.postTaskletActivity.callCount, publications)
		const pending = registerInteraction(children[0], "question")
		assert.equal(host.observationInventory().find((row) => row.taskletId === id)!.state, "waiting_for_parent")
		assert.equal(host.observationSummary().activeCount, 16)
		const transcript = await host.readObservationTranscript(id)
		assert.strictEqual(transcript.messages, children[0].presentation, "Live reads borrow history for bounded paging")
		assert.equal("conversation" in transcript, false)
		assert.equal(transcript.outcome, undefined)
		await message(id, { type: "reply", reply_to: pending.requestId, text: "Continue" })
		await pending.waiting
		assert.equal(host.observationInventory().find((row) => row.taskletId === id)!.state, "running")
		children[0].outcome.resolve({ kind: "completed", response: fullText, completedAt: 123 })
		await host["children"].get(id)!.settlement
		assert.equal(host.observationInventory().find((row) => row.taskletId === id)!.state, "completed")
		assert.equal(host.observationInventory("active").length, 15)
		assert.equal(host.observationSummary().activeCount, 15)
		assert.equal(owner.postTaskletActivity.callCount, publications + 1)
		assert.deepEqual(rootMessages!.getDiracMessages().map((entry) => entry.id), ["root-user"])
		await host.shutdown()
		await rootMessages!.saveDiracMessagesAndUpdateHistory()
		const saved = await getSavedPresentationHistory("root")
		rootMessages!.setDiracMessages(saved.messages, saved.lastOffset)
		host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		assert.notEqual(host.observationSourceId, sourceId)
		await host.reconstruct()
		await host.reconcileRootProjection()
		assert.equal(constructed.callCount, 16)
		assert.equal(host.observationSummary().activeCount, 0)
		assert.equal(host.observationInventory("all").length, 16)
		assert.deepEqual(rootMessages!.getDiracMessages().map((entry) => entry.id), ["root-user"])
	})

	it("keeps activity-publication failure informational without losing resolution, settlement or resumption", async () => {
		expectLoggerErrors()
		await projectRoot()
		owner.postTaskletActivity.rejects(new Error("Controlled display failure"))
		const { id } = await host.start({ title: "Display failure", prompt: "Work" })
		const answered = registerInteraction(children[0], "answered")
		assert.equal((await message(id, { type: "reply", reply_to: answered.requestId, text: "Continue" })).status, "resolved")
		await answered.waiting
		const retired = registerInteraction(children[0], "retired")
		children[0].outcome.resolve({ kind: "completed", response: fullText, completedAt: 123 })
		const stopped = await call<TaskletSummary>({ operation: "interrupt", tasklet_id: id })
		await assert.rejects(retired.waiting, /retired/)
		assert.equal(stopped.outcome?.kind, "completed")
		assert.equal(stopped.outcomePersisted, true)
		assert.equal(stopped.settlementError, undefined)
		assert.equal(host.observationSummary().activeCount, 0)
		const events = await loadTaskletEvents(address(id))
		assert.deepEqual(
			events.flatMap((event) => (event.communication.type === "interaction" ? [event.communication.request.status] : [])),
			["resolved", "retired"],
		)
		assert.equal(events.filter((event) => event.communication.type === "outcome").length, 1)
		owner.postTaskletActivity.resolves()
		await call({ operation: "resume", tasklet_id: id })
		assert.equal(host.observationSummary().activeCount, 1)
		assert.equal(host.observationInventory()[0].state, "running")
		assert.equal((await host.readObservationTranscript(id)).outcome, undefined)
	})

	it("replaces cumulative usage exactly once across repeated snapshots, reconstruction and explicit resume", async () => {
		await projectRoot()
		const { id } = await host.start({ title: "Account once", prompt: "Use primary and Utility" })
		const usage: TaskletUsageSnapshot = {
			primary: { tokensIn: 100, tokensOut: 20, cost: 1, reasoningTokens: 3 },
			utility: { tokensIn: 10, tokensOut: 2, cost: 0.25, reasoningTokens: 1 },
		}
		children[0].params.tasklet!.recordUsage!(usage)
		children[0].params.tasklet!.recordUsage!(usage)
		children[0].outcome.resolve({ kind: "completed", response: "Done", completedAt: 123 })
		await call({ operation: "interrupt", tasklet_id: id })
		await host.shutdown()
		host = new TaskletHost(owner, options, constructed as unknown as typeof Task)
		await host.reconstruct()
		await host.reconcileRootProjection()
		await host.reconcileRootProjection()
		await call({ operation: "resume", tasklet_id: id })
		assert.deepEqual(children[1].params.tasklet!.usage, usage)
		children[1].params.tasklet!.recordUsage!(usage)
		const increased = { primary: { ...usage.primary, tokensIn: 150, cost: 1.5 }, utility: usage.utility }
		children[1].params.tasklet!.recordUsage!(increased)
		children[1].outcome.resolve({ kind: "completed", response: "Follow-up", completedAt: 124 })
		await call({ operation: "interrupt", tasklet_id: id })
		const messages = rootMessages!.getDiracMessages()
		const accounting = messages.flatMap((entry) =>
			entry.content.type === DiracMessageType.CARD && getTaskletUsage(entry.content.card) ? [entry] : [],
		)
		assert.deepEqual(
			accounting.map((entry) => entry.id),
			[`tasklet-usage:${id}`],
		)
		assert.equal(getApiMetrics(messages).totalCost, 1.75)
		assert.equal(getApiMetrics(messages).totalTokensIn, 160)
		assert.deepEqual((await loadTaskletRecords("root"))[0].usage, increased)
	})

	it("sleep wakes on committed silent failure without consuming it or joining other children", async () => {
		const { id } = await host.start({ title: "Silent failure", prompt: "Work" })
		await acknowledgeEvents()
		const sleeping = call<TaskletWakeResult>({ operation: "sleep", tasklet_ids: [id] })
		await inspect(id)
		assert.equal(host.isSleeping, true)
		children[0].outcome.resolve({
			kind: "failed",
			failedAt: 130,
			error: { name: "Error", message: "Provider stopped silently" },
		})
		await host["children"].get(id)!.settlement
		const wake = await sleeping
		assert.equal(wake.reason, "event")
		assert.deepEqual(await call({ operation: "sleep", tasklet_ids: [id] }), wake)
		const events = await loadTaskletEvents(address(id))
		assert.equal(events.at(-1)!.communication.type, "outcome")
		assert.equal(events.at(-1)!.deliveredAt, undefined)
		await inspect(id)
		assert.equal((await loadTaskletEvents(address(id))).at(-1)!.deliveredAt, undefined)
		await acknowledgeEvents()
		assert.equal(await host.prepareEventDelivery(), undefined)
	})

	it("supports time-only waits and gives user input priority over retained communication", async () => {
		const { id } = await host.start({ title: "Selected", prompt: "Work" })
		const clock = sandbox.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const sleeping = call({ operation: "sleep", tasklet_ids: [], timeout_ms: 50 })
		await inspect(id)
		assert.equal(host.isSleeping, true)
		await clock.tickAsync(50)
		assert.deepEqual(await sleeping, { reason: "timeout" })
		await acknowledgeEvents()
		for (const ids of [[id], []]) {
			const waiting = call({ operation: "sleep", tasklet_ids: ids, timeout_ms: 60_000 })
			await inspect(id)
			assert.equal(host.isSleeping, true)
			host.notifyUserMessage()
			assert.deepEqual(await waiting, { reason: "user_message" })
		}
		await children[0].params.tasklet!.counterparty.recordResponse({ operation: ResponseOperation.PROGRESS, text: "Retained" })
		owner.hasPendingUserInput.returns(true)
		assert.deepEqual(await call({ operation: "sleep" }), { reason: "user_message" })
	})
})
