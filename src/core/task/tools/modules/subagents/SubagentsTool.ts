import { formatResponse } from "@core/formatResponse"
import { CardStatus } from "@shared/ExtensionMessage"
import {
	formatTaskletReceipt,
	TASKLET_RECEIPT_OPERATIONS,
	TASKLET_RECEIPT_OUTCOMES,
	taskletReceiptNote,
	taskletReceiptTitle,
	type TaskletReceipt,
	type TaskletReceiptOutcome,
	type TaskletReceiptRow,
} from "@shared/taskletReceipt"
import { SUBAGENT_TASK_TITLE_MAX_CHARS, SUBAGENT_TASK_TITLE_MAX_WORDS } from "@shared/subagents"
import { toError } from "@/shared/errors"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type {
	TaskletControls,
	TaskletInspectionQuery,
	TaskletMessage,
	TaskletMessageResult,
	TaskletSleepOptions,
} from "../../interfaces/IToolEnvironment"
import type { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { waitForPresentationOperation } from "../../subagent/PresentationDeadline"

const assignmentParameter: NonNullable<DiracToolSpec["parameters"]>[number] = {
	name: "assignments",
	type: "array",
	required: false,
	minItems: 1,
	instruction:
		"Assignments to start concurrently; one assignment still uses a one-element array. Acceptance is not completion.",
	items: {
		type: "object",
		properties: {
			type: {
				type: "string",
				enum: ["default"],
				description: "Role for this assignment. default uses the main agent's current model settings.",
			},
			task_header: {
				type: "string",
				minLength: 1,
				maxLength: SUBAGENT_TASK_TITLE_MAX_CHARS,
				description: `Short assignment header, at most ${SUBAGENT_TASK_TITLE_MAX_WORDS} words.`,
			},
			task_description: {
				type: "string",
				minLength: 1,
				description: "Complete assignment instructions and necessary context; no parent conversation is copied.",
			},
		},
		required: ["type", "task_header", "task_description"],
		additionalProperties: false,
	},
}

export class SubagentsTool implements IDiracTool {
	spec(): DiracToolSpec {
		return subagents_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: unknown, env: IToolEnvironment): Promise<string> {
		const input = requireArguments(args)
		if (input.operation !== "create") return executeControlCall(input, env)
		if (!env.config.subagentsEnabled) throw new Error("Subagent creation is disabled")
		return this.createAssignments(input, env)
	}

	private async createAssignments(input: Record<string, unknown>, env: IToolEnvironment): Promise<string> {
		const controls = env.orchestration.tasklets
		if (!controls) throw new Error("Tasklet spawning is available only to an owning root")
		rejectUnknownFields(input, ["operation", "assignments"], "subagents create")
		const assignments: unknown[] = Array.isArray(input.assignments) ? input.assignments : []
		if (assignments.length === 0) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError("assignments must be a non-empty array")
		}

		const card = await this.createSpawnCard(env)
		const instructions: (string | undefined)[] = []
		const results = await Promise.all(
			assignments.map(async (assignment, index) => {
				let title: string | undefined
				try {
					const request = this.parseRequest(assignment, `Subagent ${index + 1}`)
					title = request.title
					instructions[index] = request.prompt
					const record = await controls.start(request)
					const outcome = record.outcome
					const error =
						outcome?.kind === "failed"
							? outcome.error.message
							: outcome?.kind === "interrupted" || outcome?.kind === "cancelled"
								? (outcome.reason ?? "Tasklet startup was cancelled")
								: undefined
					return {
						index,
						id: record.id,
						title: record.title,
						...(record.role === undefined ? {} : { role: record.role }),
						accepted: error === undefined,
						...(outcome ? { outcome } : {}),
						...(error === undefined ? {} : { error }),
					}
				} catch (error) {
					return { index, ...(title ? { title } : {}), accepted: false, error: toError(error).message }
				}
			}),
		)
		if (card) {
			const accepted = results.filter((result) => result.accepted).length
			const status = accepted === results.length ? CardStatus.SUCCESS : CardStatus.ERROR
			const receipt: TaskletReceipt = {
				operation: "spawn",
				outcome: accepted === results.length ? "accepted" : accepted > 0 ? "partial_failure" : "failed",
				rows: results.map((result) => ({
					operation: "spawn",
					taskletId: "id" in result ? result.id : undefined,
					title: result.title ?? `Agent ${result.index + 1}`,
					role: "role" in result ? result.role : undefined,
					message: instructions[result.index],
					outcome: result.accepted ? "accepted" : "failed",
					error: result.error,
				})),
			}
			await this.present(card.update(receiptCard(receipt, status, env.orchestration.agentIdentity.id)), env)
			await this.present(card.finalize(status), env)
		}
		return JSON.stringify({ subagents: results }, null, 2)
	}

	private parseRequest(input: unknown, subject: string) {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error(`${subject} assignment must be an object`)
		const args = input as Record<string, unknown>
		rejectUnknownFields(args, ["type", "task_header", "task_description"], subject)
		const type = requireString(args, "type").trim()
		const prompt = requireString(args, "task_description").trim()
		const title = requireString(args, "task_header").trim().replace(/\s+/g, " ")
		if (title.split(" ").length > SUBAGENT_TASK_TITLE_MAX_WORDS)
			throw new Error(`${subject} task_header must contain no more than ${SUBAGENT_TASK_TITLE_MAX_WORDS} words`)
		if (title.length > SUBAGENT_TASK_TITLE_MAX_CHARS)
			throw new Error(`${subject} task_header must contain no more than ${SUBAGENT_TASK_TITLE_MAX_CHARS} characters`)
		return { title, prompt, type }
	}

	private async createSpawnCard(env: IToolEnvironment): Promise<ICardHandle | undefined> {
		const creation = env.ui.createCard({
			...receiptCard(
				{ operation: "spawn", outcome: "requested", rows: [] },
				CardStatus.RUNNING,
				env.orchestration.agentIdentity.id,
			),
		})
		try {
			const result = await waitForPresentationOperation(creation)
			if (!result.timedOut) return result.value
			env.logging.warn("[SubagentsTool] Spawn card creation timed out")
			void creation
				.then((card) => this.present(card.finalize(CardStatus.ABANDONED), env))
				.catch((error) => {
					env.logging.warn("[SubagentsTool] Late spawn card creation failed", toError(error))
				})
		} catch (error) {
			env.logging.warn("[SubagentsTool] Spawn card creation failed", toError(error))
		}
		return undefined
	}

	private async present(operation: Promise<void>, env: IToolEnvironment): Promise<void> {
		try {
			const result = await waitForPresentationOperation(operation)
			if (result.timedOut) env.logging.warn("[SubagentsTool] Spawn card presentation timed out")
		} catch (error) {
			env.logging.warn("[SubagentsTool] Spawn card presentation failed", toError(error))
		}
	}
}

const operations = ["list", "inspect", "message", "interrupt", "resume", "sleep"] as const
const inspectionViews = ["status", "messages", "pending", "trajectory", "call", "result", "transcript", "assignment"] as const
const messageTypes = ["guidance", "reply", "permission_decision"] as const
const permissionDecisions = ["approve", "reject", "escalate"] as const
const queryFields = ["view", "cursor", "limit", "call_id", "message_type"]
const MAX_MESSAGE_RESULTS_BYTES = 16 * 1024

type Operation = (typeof operations)[number]
type ControlRequest =
	| { operation: "list"; query?: TaskletInspectionQuery }
	| { operation: "inspect"; taskletId: string; query?: TaskletInspectionQuery }
	| { operation: "message"; items: TaskletMessage[] }
	| { operation: "interrupt" | "resume"; taskletId: string; message?: string }
	| { operation: "sleep"; options: TaskletSleepOptions }

export const subagents_spec: DiracToolSpec = {
	id: DiracDefaultTool.SUBAGENTS,
	name: "subagents",
	description:
		"Create and supervise this root's private subagents. Create accepts a batch of complete assignments asynchronously, not completed results; children do not receive the parent conversation. List and inspect are passive bounded reads; use returned cursors and call_id for exact evidence. Message sends 1–20 parent guidance, structured replies or permission decisions. Ordinary questions and peer mail use send_message instead. Guidance is queued, not necessarily consumed; free-text replies never grant permission. Replies and permission decisions require the exact request_id and never exceed current parent authority. Each item reports its own outcome, including partial failure. Ask the user and relay their answer for child questions needing user input. Resume explicitly accepts follow-up work under the same ID, not completion. Interrupt awaits settlement. Sleep waits for communication, a deadline or user input without consuming events or joining children. Omit tasklet_ids for any child; [] requires timeout_ms and waits only for time/user input. A wake is not completion.",
	parameters: [
		{ name: "operation", required: true, instruction: "Creation or supervision operation.", enum: ["create", ...operations] },
		assignmentParameter,
		{
			name: "tasklet_id",
			required: false,
			instruction: "Routing identity; required for inspect, interrupt and resume. Message recipients belong in messages.",
			minLength: 1,
		},
		{
			name: "view",
			required: false,
			instruction: "Inspect view; defaults to status. List supports status only.",
			enum: inspectionViews,
		},
		{
			name: "cursor",
			required: false,
			instruction:
				"Use nextCursor for more recorded data, or a messages tailCursor on a later read for newly appended messages. Keep the same view and filters; cursors never acknowledge delivery.",
			minLength: 1,
		},
		{
			name: "limit",
			type: "integer",
			required: false,
			instruction: "Positive page size; aggregate output bounds still apply.",
			minimum: 1,
			maximum: 50,
		},
		{
			name: "call_id",
			required: false,
			instruction: "Exact tool-call identity, required for call/result views.",
			minLength: 1,
		},
		{ name: "message_type", required: false, instruction: "Optional type filter for the messages view.", minLength: 1 },
		{
			name: "messages",
			type: "array",
			required: false,
			instruction:
				"Required for message, including a single item. Shape and duplicate/conflicting targets are checked before applying any item.",
			minItems: 1,
			maxItems: 20,
			items: {
				type: "object",
				properties: {
					tasklet_id: { type: "string", minLength: 1, description: "Recipient routing identity." },
					type: { type: "string", enum: messageTypes },
					text: {
						type: "string",
						minLength: 1,
						maxLength: 8000,
						description: "Guidance or reply text; never permission authority.",
					},
					request_id: {
						type: "string",
						minLength: 1,
						description: "Exact request identity, required for replies and permission decisions.",
					},
					action: {
						type: "string",
						minLength: 1,
						description: "Exact displayed choice for a reply, not a permission grant.",
					},
					decision: { type: "string", enum: permissionDecisions, description: "Only for permission_decision." },
				},
				required: ["tasklet_id", "type"],
				additionalProperties: false,
			},
		},
		{
			name: "message",
			required: false,
			instruction:
				"Only for resume (explicit follow-up assignment) or interrupt (reason). Use messages for all direct communication.",
			minLength: 1,
		},
		{
			name: "tasklet_ids",
			type: "array",
			required: false,
			instruction: "Only for sleep: communication sources. Omit for any; [] for time/user only.",
			items: { type: "string", minLength: 1 },
		},
		{
			name: "timeout_ms",
			type: "integer",
			required: false,
			instruction: "Only for sleep: optional relative deadline in milliseconds.",
			minimum: 0,
			maximum: 2147483647,
		},
	],
}

async function executeControlCall(input: unknown, env: IToolEnvironment): Promise<string> {
	const controls = env.orchestration.tasklets
	if (!controls) throw new Error("Tasklet controls are available only to an owning root")
	const args = requireArguments(input)
	const request = parseControlRequest(args)
	const actor = env.orchestration.agentIdentity.id
	const initialReceipts = individualReceipts(controlReceipt(request))
	const cards = await Promise.all(
		initialReceipts.map((receipt) =>
			env.ui.createCard({
				...receiptCard(receipt, CardStatus.RUNNING, actor),
				rawInput: args,
			}),
		),
	)
	try {
		const result = await executeOperation(controls, request)
		const output = JSON.stringify(result)
		if (Buffer.byteLength(output, "utf8") > MAX_MESSAGE_RESULTS_BYTES)
			throw new Error("Tasklet control output exceeded its aggregate bound; use a bounded inspection view")
		const receipts = individualReceipts(controlReceiptResult(request, result))
		for (const [index, receipt] of receipts.entries()) {
			const status =
				receipt.outcome === "failed" || receipt.outcome === "partial_failure" || receipt.outcome === "stale"
					? CardStatus.ERROR
					: CardStatus.SUCCESS
			const content = receiptCard(receipt, status, actor)
			await cards[index].update(content)
			await cards[index].finalize(status)
		}
		return output
	} catch (error) {
		for (const [index, receipt] of initialReceipts.entries()) {
			await cards[index].update(
				receiptCard(
					{
						...receipt,
						outcome: "failed",
						rows: receipt.rows.map((row) => ({ ...row, outcome: "failed" })),
						error: clipText(toError(error).message, 2000),
					},
					CardStatus.ERROR,
					actor,
				),
			)
			await cards[index].finalize(CardStatus.ERROR)
		}
		throw error
	}
}

function requireArguments(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Tasklet control arguments must be an object")
	return input as Record<string, unknown>
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key]
	if (typeof value !== "string" || !value.trim()) throw new Error(`Parameter '${key}' must be a non-empty string`)
	return value
}

function rejectUnknownFields(args: Record<string, unknown>, fields: string[], subject: string): void {
	for (const key of Object.keys(args)) {
		if (!fields.includes(key)) throw new Error(`Parameter '${key}' is not valid for ${subject}`)
	}
}

function parseControlRequest(args: Record<string, unknown>): ControlRequest {
	if (typeof args.operation !== "string" || !operations.includes(args.operation as Operation))
		throw new Error(`Unknown tasklet operation: ${String(args.operation)}`)
	const operation = args.operation as Operation
	const fields: Record<Operation, string[]> = {
		list: queryFields,
		inspect: ["tasklet_id", ...queryFields],
		message: ["messages"],
		interrupt: ["tasklet_id", "message"],
		resume: ["tasklet_id", "message"],
		sleep: ["tasklet_ids", "timeout_ms"],
	}
	rejectUnknownFields(args, ["operation", ...fields[operation]], operation)
	switch (operation) {
		case "list":
			return { operation, query: parseInspectionQuery(args, true) }
		case "inspect":
			return { operation, taskletId: requireString(args, "tasklet_id"), query: parseInspectionQuery(args) }
		case "message":
			return { operation, items: parseMessageBatch(args.messages) }
		case "interrupt":
		case "resume":
			return {
				operation,
				taskletId: requireString(args, "tasklet_id"),
				message: args.message === undefined ? undefined : requireString(args, "message"),
			}
		case "sleep":
			return { operation, options: parseSleepOptions(args) }
	}
}

function parseInspectionQuery(args: Record<string, unknown>, list = false): TaskletInspectionQuery | undefined {
	if (args.view !== undefined && !inspectionViews.includes(args.view as (typeof inspectionViews)[number]))
		throw new Error("Unknown tasklet inspection view")
	const view = args.view as TaskletInspectionQuery["view"]
	if (list && view !== undefined && view !== "status") throw new Error("list supports only the status view")
	if (
		args.limit !== undefined &&
		(!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 50)
	)
		throw new Error("limit must be an integer from 1 to 50")
	if (args.call_id !== undefined && (list || (view !== "call" && view !== "result")))
		throw new Error("call_id is valid only for call/result inspection")
	if ((view === "call" || view === "result") && args.call_id === undefined)
		throw new Error("call_id is required for call/result inspection")
	if (args.message_type !== undefined && (list || view !== "messages"))
		throw new Error("message_type is valid only for messages inspection")
	const query: TaskletInspectionQuery = {
		...(view === undefined ? {} : { view }),
		...(args.cursor === undefined ? {} : { cursor: requireString(args, "cursor") }),
		...(args.limit === undefined ? {} : { limit: args.limit as number }),
		...(args.call_id === undefined ? {} : { callId: requireString(args, "call_id") }),
		...(args.message_type === undefined ? {} : { messageType: requireString(args, "message_type") }),
	}
	return Object.keys(query).length ? query : undefined
}

function parseSleepOptions(args: Record<string, unknown>): TaskletSleepOptions {
	if (
		args.tasklet_ids !== undefined &&
		(!Array.isArray(args.tasklet_ids) || args.tasklet_ids.some((id) => typeof id !== "string" || !id.trim()))
	)
		throw new Error("tasklet_ids must be an array of non-empty IDs")
	if (
		args.timeout_ms !== undefined &&
		(!Number.isInteger(args.timeout_ms) || (args.timeout_ms as number) < 0 || (args.timeout_ms as number) > 2147483647)
	)
		throw new Error("timeout_ms must be an integer from 0 to 2147483647")
	if (Array.isArray(args.tasklet_ids) && args.tasklet_ids.length === 0 && args.timeout_ms === undefined)
		throw new Error("Time-only sleep requires timeout_ms")
	return { taskletIds: args.tasklet_ids as string[] | undefined, timeoutMs: args.timeout_ms as number | undefined }
}

function parseMessageBatch(input: unknown): TaskletMessage[] {
	if (!Array.isArray(input) || input.length === 0 || input.length > 20)
		throw new Error("messages must contain between 1 and 20 addressed items")
	const targets = new Set<string>()
	return input.map((value) => {
		const args = requireArguments(value)
		const taskletId = requireRoutingIdentity(args, "tasklet_id")
		const type = args.type
		let item: TaskletMessage
		if (type === "guidance") {
			rejectUnknownFields(args, ["tasklet_id", "type", "text"], type)
			item = { taskletId, type, text: requireMessageText(args) }
		} else if (type === "reply") {
			rejectUnknownFields(args, ["tasklet_id", "type", "request_id", "text", "action"], type)
			if (args.text === undefined && args.action === undefined)
				throw new Error("A reply requires text or an exact displayed action")
			item = {
				taskletId,
				type,
				requestId: requireRoutingIdentity(args, "request_id"),
				...(args.text === undefined ? {} : { text: requireMessageText(args) }),
				...(args.action === undefined ? {} : { action: requireMessageText({ text: args.action }) }),
			}
		} else if (type === "permission_decision") {
			rejectUnknownFields(args, ["tasklet_id", "type", "request_id", "decision"], type)
			if (!permissionDecisions.includes(args.decision as (typeof permissionDecisions)[number]))
				throw new Error("Invalid permission decision")
			item = {
				taskletId,
				type,
				requestId: requireRoutingIdentity(args, "request_id"),
				decision: args.decision as "approve" | "reject" | "escalate",
			}
		} else throw new Error("Unknown tasklet message type")
		const target = JSON.stringify([taskletId, "requestId" in item ? ["request", item.requestId] : [type, item.text]])
		if (targets.has(target)) throw new Error("Duplicate or conflicting message targets in batch")
		targets.add(target)
		return item
	})
}

function requireRoutingIdentity(args: Record<string, unknown>, key: string): string {
	const value = requireString(args, key)
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > 128)
		throw new Error(`Parameter '${key}' is too long for a routing identity`)
	return value
}

function requireMessageText(args: Record<string, unknown>): string {
	const text = requireString(args, "text")
	if (text.length > 8000) throw new Error("Message text must contain at most 8000 characters")
	return text
}

async function executeOperation(controls: TaskletControls, request: ControlRequest): Promise<unknown> {
	switch (request.operation) {
		case "list":
			return request.query ? controls.list(request.query) : controls.list()
		case "inspect":
			return request.query ? controls.inspect(request.taskletId, request.query) : controls.inspect(request.taskletId)
		case "message":
			return compactMessageResults(request.items, await controls.message(request.items))
		case "interrupt":
			return controls.interrupt(request.taskletId, request.message)
		case "resume": {
			const record = await controls.resume(request.taskletId, request.message)
			return {
				id: record.id,
				title: clipText(record.title, 256),
				...(record.role === undefined ? {} : { role: record.role }),
				accepted: !record.outcome,
				...(record.outcome ? { startupOutcome: record.outcome.kind } : {}),
			}
		}
		case "sleep":
			return controls.sleep(request.options)
	}
}

/** Retain every addressed outcome; share a fixed JSON budget among optional human summaries. */
function compactMessageResults(items: TaskletMessage[], results: TaskletMessageResult[]): TaskletMessageResult[] {
	const compact = results.map((result, index) => ({
		taskletId: items[index].taskletId,
		status: result.status,
		...("requestId" in items[index]
			? { requestId: (items[index] as Extract<TaskletMessage, { requestId: string }>).requestId }
			: {}),
		...(result.messageId && Buffer.byteLength(JSON.stringify(result.messageId), "utf8") <= 128
			? { messageId: result.messageId }
			: {}),
	})) as TaskletMessageResult[]
	const fieldBudget = Math.min(
		512,
		Math.floor(
			(MAX_MESSAGE_RESULTS_BYTES - Buffer.byteLength(JSON.stringify(compact), "utf8") - results.length * 128) /
			(results.length * 4),
		),
	)
	for (const [index, result] of results.entries()) {
		for (const key of ["title", "role", "request", "error"] as const) {
			if (result[key] !== undefined) compact[index][key] = clipText(result[key]!, fieldBudget)
		}
	}
	return compact
}

/** Bound the serialized string, including escaping, and make excerpting visible. */
function clipText(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maximumBytes) return value
	let lower = 0
	let upper = value.length
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2)
		if (Buffer.byteLength(JSON.stringify(`${value.slice(0, middle)}…`), "utf8") <= maximumBytes) lower = middle
		else upper = middle - 1
	}
	if (lower > 0 && /[\uD800-\uDBFF]/.test(value[lower - 1]) && /[\uDC00-\uDFFF]/.test(value[lower])) lower--
	return `${value.slice(0, lower)}…`
}

function controlReceipt(request: ControlRequest): TaskletReceipt {
	if (request.operation === "message") {
		return {
			operation: request.items.length === 1 ? request.items[0].type : "message",
			outcome: "requested",
			rows: request.items.map((item) => ({
				operation: item.type,
				taskletId: item.taskletId,
				title: "Agent",
				outcome: "requested",
				message: "text" in item ? item.text : undefined,
				choice: item.type === "reply" ? item.action : undefined,
				requestId: "requestId" in item ? item.requestId : undefined,
				decision: item.type === "permission_decision" ? item.decision : undefined,
			})),
		}
	}
	return {
		operation: request.operation,
		outcome: "requested",
		view: request.operation === "inspect" ? (request.query?.view ?? "status") : undefined,
		rows:
			"taskletId" in request
				? [
					{
						operation: request.operation,
						taskletId: request.taskletId,
						title: "Agent",
						outcome: "requested",
						message: "message" in request ? request.message : undefined,
					},
				]
				: [],
		...(request.operation === "sleep"
			? {
				waitScope:
					request.options.taskletIds === undefined
						? "any_tasklet"
						: request.options.taskletIds.length
							? "selected_tasklets"
							: "time_or_user",
				waitSourceCount: request.options.taskletIds?.length,
				waitSourceIds: request.options.taskletIds,
			}
			: {}),
	}
}

function receiptCard(taskletReceipt: TaskletReceipt, status: CardStatus, actor: string) {
	const detail = [
		TASKLET_RECEIPT_OUTCOMES[taskletReceipt.outcome].label,
		taskletReceiptNote(taskletReceipt),
		taskletReceipt.error || taskletReceipt.rows.some((row) => row.error)
			? "Operation failed; see tool result for details."
			: undefined,
	]
		.filter(Boolean)
		.join(" · ")
	return {
		header: taskletReceiptTitle(taskletReceipt, actor),
		icon: TASKLET_RECEIPT_OPERATIONS[taskletReceipt.operation].icon,
		body: formatTaskletReceipt(taskletReceipt, true),
		communication: { actor, detail },
		collapsed: true,
		taskletReceipt,
		status,
	}
}

function resultObject(result: unknown): Record<string, unknown> {
	return result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {}
}

function resultTitle(result: Record<string, unknown>): string {
	return typeof result.title === "string" && result.title !== result.id ? clipText(result.title, 256) : "Tasklet"
}

function controlReceiptResult(request: ControlRequest, value: unknown): TaskletReceipt {
	if (request.operation === "message") return messageReceiptResult(request.items, value as TaskletMessageResult[])
	const result = resultObject(value)
	const receipt = controlReceipt(request)
	const title = resultTitle(result)
	const role = typeof result.role === "string" ? result.role : undefined
	if (request.operation === "resume") {
		const outcome = result.accepted ? "accepted" : "failed"
		return {
			...receipt,
			outcome,
			rows: [
				{
					...receipt.rows[0],
					title,
					role,
					outcome,
					error: result.accepted ? undefined : `Resumption did not start: ${String(result.startupOutcome)}`,
				},
			],
		}
	}
	if (request.operation === "interrupt") {
		const failed = Boolean(result.settlementError) || !result.outcomePersisted
		const outcome = failed ? "failed" : "settled"
		return {
			...receipt,
			outcome,
			rows: [
				{
					...receipt.rows[0],
					title,
					role,
					outcome,
					observedState: observedReceiptState(result),
					error: failed
						? String(resultObject(result.settlementError).message ?? "Settlement did not complete")
						: undefined,
				},
			],
		}
	}
	if (request.operation === "sleep") {
		const wakeReason = result.reason as TaskletReceipt["wakeReason"]
		return { ...receipt, outcome: wakeReason === "cancelled" ? "cancelled" : "woke", wakeReason }
	}
	const items = Array.isArray(result.items) ? result.items : []
	return {
		...receipt,
		outcome: "retrieved",
		returnedCount: items.length,
		totalCount: typeof result.totalItems === "number" ? result.totalItems : items.length,
		hasMore: typeof result.nextCursor === "string",
		fragment: result.fragment !== undefined,
		rows:
			request.operation === "inspect"
				? [
					{
						...receipt.rows[0],
						title,
						role,
						outcome: "retrieved",
						observedState:
							(request.query?.view ?? "status") === "status" && items.length === 1
								? observedReceiptState(resultObject(items[0]))
								: undefined,
					},
				]
				: items.map((item) => {
					const summary = resultObject(item)
					return {
						operation: "list",
						taskletId: typeof summary.id === "string" ? summary.id : undefined,
						title: resultTitle(summary),
						role: typeof summary.role === "string" ? summary.role : undefined,
						outcome: "retrieved",
						observedState: observedReceiptState(summary),
					}
				}),
	}
}

function observedReceiptState(summary: Record<string, unknown>): TaskletReceiptRow["observedState"] {
	if (summary.settlementError) return "settlement_failed"
	if (summary.outcomePersisted === true) {
		const kind = resultObject(summary.outcome).kind
		if (kind === "completed" || kind === "failed" || kind === "interrupted") return kind
		if (kind === "cancelled") return "interrupted"
	}
	if (summary.outcome && summary.outcomePersisted === false) return "settling"
	if (typeof summary.pendingRequestCount === "number" && summary.pendingRequestCount > 0) return "waiting_for_parent"
	switch (summary.executionStatus) {
		case "preparing":
			return "starting"
		case "completed":
		case "cancelling":
			return summary.outcomePersisted === false ? "settling" : undefined
		case "waiting_for_api":
		case "thinking":
		case "streaming_text":
		case "building_tool_call":
		case "executing_tool":
			return "running"
		default:
			return undefined
	}
}

function messageReceiptResult(items: TaskletMessage[], results: TaskletMessageResult[]): TaskletReceipt {
	const receipt = controlReceipt({ operation: "message", items })
	const rows = receipt.rows.map((row, index) => ({
		...row,
		title: results[index].title ?? "Agent",
		role: results[index].role,
		outcome: results[index].status,
		request: results[index].request,
		error: results[index].error,
	}))
	return { ...receipt, outcome: batchReceiptOutcome(rows), rows }
}

function batchReceiptOutcome(rows: TaskletReceiptRow[]): TaskletReceiptOutcome {
	const failures = rows.filter((row) => row.outcome === "failed" || row.outcome === "stale").length
	if (failures) return failures === rows.length ? "failed" : "partial_failure"
	if (rows.every((row) => row.outcome === rows[0].outcome)) return rows[0].outcome
	if (rows.some((row) => row.outcome === "requires_user_approval")) return "requires_user_approval"
	return "recorded"
}

function individualReceipts(receipt: TaskletReceipt): TaskletReceipt[] {
	if (receipt.operation !== "message") return [receipt]
	return receipt.rows.map((row) => ({ ...receipt, operation: row.operation, outcome: row.outcome, rows: [row] }))
}