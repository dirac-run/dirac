import { createHash } from "node:crypto"
import type {
	TaskletEvent,
	TaskletInspection,
	TaskletInteraction,
	TaskletInspectionQuery,
	TaskletInspectionPage,
	TaskletSummary,
} from "./types/tasklet"
import type { DiracAssistantToolUseBlock, DiracStorageMessage, DiracUserToolResultContentBlock } from "@shared/messages/content"
import { taskletUsageTotal } from "@shared/taskletUsage"
import type { TaskRunOutcome } from "./TaskRunOutcome"
export type { TaskletInspectionQuery, TaskletInspectionPage, TaskletSummary } from "./types/tasklet"

export const MAX_TASKLET_INSPECTION_BYTES = 16 * 1024
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const VIEWS = new Set(["status", "messages", "pending", "trajectory", "call", "result", "transcript", "assignment"])

export interface TaskletInspectionSource {
	inspection: TaskletInspection
	events: TaskletEvent[]
	readConversation: () => Promise<DiracStorageMessage[]>
}

function preview(text: string, length = 600): string {
	return text.length <= length ? text : `${text.slice(0, length)}… [preview; inspect the corresponding evidence view]`
}

function summarizeOutcome(outcome: TaskRunOutcome): NonNullable<TaskletSummary["outcome"]> {
	switch (outcome.kind) {
		case "completed":
			return { kind: outcome.kind, summary: preview(outcome.response), at: outcome.completedAt }
		case "failed":
			return { kind: outcome.kind, summary: preview(outcome.error.message), at: outcome.failedAt }
		case "cancelled":
			return { kind: outcome.kind, summary: preview(outcome.reason ?? "Cancelled"), at: outcome.cancelledAt }
		case "interrupted":
			return { kind: outcome.kind, summary: preview(outcome.reason), at: outcome.interruptedAt }
	}
}

/** Compact inventory/status, never a replay of responses, requests, presentation, or assignment input. */
export function summarizeTasklet(inspection: TaskletInspection): TaskletSummary {
	const progress = [...inspection.responses].reverse().find((response) => response.operation === "progress")
	return {
		id: inspection.id,
		title: preview(inspection.title, 300),
		...(inspection.role === undefined ? {} : { role: inspection.role }),
		createdAt: inspection.createdAt,
		executionStatus: inspection.executionStatus,
		pendingRequestCount: inspection.interactions.filter((request) => request.status === "pending").length,
		...(progress ? { latestProgress: preview(progress.text) } : {}),
		lastActivityAt: inspection.lastActivityAt,
		backgroundCommandRunning: inspection.backgroundCommandRunning,
		outcomePersisted: inspection.outcomePersisted,
		...(inspection.outcomePersisted && inspection.outcome ? { outcome: summarizeOutcome(inspection.outcome) } : {}),
		...(inspection.settlementError
			? {
				settlementError: {
					name: preview(inspection.settlementError.name, 100),
					message: preview(inspection.settlementError.message),
				},
			}
			: {}),
		...(inspection.presentationError
			? {
				presentationError: {
					name: preview(inspection.presentationError.name, 100),
					message: preview(inspection.presentationError.message),
				},
			}
			: {}),
		...(inspection.usage ? { usage: taskletUsageTotal(inspection.usage) } : {}),
	}
}

function validateQuery(query: TaskletInspectionQuery): number {
	if (query.view !== undefined && !VIEWS.has(query.view)) throw new Error("Unknown tasklet inspection view")
	const limit = query.limit === undefined ? DEFAULT_LIMIT : query.limit
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
		throw new Error("Inspection limit must be an integer between 1 and 50")
	if (query.callId !== undefined && (typeof query.callId !== "string" || !query.callId || query.callId.length > 512)) {
		throw new Error("Inspection callId must be a non-empty string of at most 512 characters")
	}
	if (
		query.messageType !== undefined &&
		(typeof query.messageType !== "string" || !query.messageType || query.messageType.length > 100)
	) {
		throw new Error("Inspection messageType must be a non-empty string of at most 100 characters")
	}
	return limit
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8")
}

/**
 * Shared inventory/evidence pagination. The bound includes the entire serialized page, not each item.
 * Oversized items retain their exact JSON across fragments; changed partial items invalidate their cursor.
 * Cursors are scoped to the view/filter/call, not acknowledgements or stable snapshots of a changing list.
 */
export function pageInspectionItems<T>(
	items: readonly T[],
	query: TaskletInspectionQuery = {},
	identity: Pick<TaskletInspectionPage, "title" | "taskletId" | "role"> = {},
): TaskletInspectionPage<T> {
	const limit = validateQuery(query)
	const scope = fingerprint(JSON.stringify([identity.taskletId, query.view, query.callId, query.messageType]))
	const cursorFor = (index: number, offset = 0, hash = "-") => `1:${index}:${offset}:${scope}:${hash}`
	const continuationAt = (index: number, offset = 0, hash = "-"): Pick<TaskletInspectionPage, "nextCursor" | "tailCursor"> => {
		const cursor = cursorFor(index, offset, hash)
		if (index < items.length) return { nextCursor: cursor }
		return query.view === "messages" ? { tailCursor: cursor } : {}
	}
	let index = 0
	let offset = 0
	let itemHash = "-"
	if (query.cursor !== undefined) {
		const match =
			typeof query.cursor === "string" && /^1:(\d{1,16}):(\d{1,16}):([a-f0-9]{16}):(-|[a-f0-9]{16})$/.exec(query.cursor)
		if (!match || match[3] !== scope) throw new Error("Invalid inspection cursor for this query")
		index = Number(match[1])
		offset = Number(match[2])
		itemHash = match[4]
		if (
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(offset) ||
			index > items.length ||
			(offset > 0 && index === items.length)
		) {
			throw new Error("Inspection cursor is outside the recorded data")
		}
	}
	const page: TaskletInspectionPage<T> = {
		...identity,
		...(query.view ? { view: query.view } : {}),
		items: [],
		totalItems: items.length,
	}
	while (index < items.length && page.items.length < limit) {
		const json = JSON.stringify(items[index])
		if (offset > 0 && (offset >= json.length || itemHash !== fingerprint(json)))
			throw new Error("Inspection fragment changed; restart this view")
		const candidate = { ...page, items: [...page.items, items[index]], ...continuationAt(index + 1) }
		if (offset === 0 && jsonBytes(candidate) <= MAX_TASKLET_INSPECTION_BYTES) {
			page.items.push(items[index++])
			continue
		}
		if (page.items.length > 0) return { ...page, nextCursor: cursorFor(index) }
		const hash = fingerprint(json)
		const totalBytes = Buffer.byteLength(json, "utf8")
		const fragmentPage = (end: number): TaskletInspectionPage<T> => ({
			...page,
			fragment: { itemIndex: index, offset, totalCharacters: json.length, totalBytes, json: json.slice(offset, end) },
			...(end < json.length ? continuationAt(index, end, hash) : continuationAt(index + 1)),
		})
		let low = offset + 1
		let high = json.length
		let end = offset
		while (low <= high) {
			const middle = Math.floor((low + high) / 2)
			// Keep surrogate pairs together, including when JSON itself contains non-ASCII evidence.
			const boundary =
				middle < json.length && /[\uD800-\uDBFF]/.test(json[middle - 1]) && /[\uDC00-\uDFFF]/.test(json[middle])
					? middle - 1
					: middle
			if (jsonBytes(fragmentPage(boundary)) <= MAX_TASKLET_INSPECTION_BYTES) {
				end = boundary
				low = middle + 1
			} else high = middle - 1
		}
		if (end === offset) throw new Error("Inspection fragment metadata exceeds the page byte bound")
		return fragmentPage(end)
	}
	return { ...page, ...continuationAt(index) }
}

function requestType(request: TaskletInteraction): string {
	if (request.permissionOperation || request.permissionRequestKind) return "permission_request"
	if (request.card.rawInput?.operation === "question" || request.card.toolName === "ask_followup_question") return "question"
	return "operational_request"
}

function pendingRequest(request: TaskletInteraction) {
	return {
		id: request.id,
		type: requestType(request),
		createdAt: request.createdAt,
		status: request.status,
		resolvedAt: request.resolvedAt,
		retiredAt: request.retiredAt,
		decision: request.decision,
		resolution: request.resolution,
		permissionRequestKind: request.permissionRequestKind,
		permissionOperation: request.permissionOperation,
		utilityPermissionEscalation: request.utilityPermissionEscalation,
		toolCall: request.toolCall,
		header: request.card.header,
		prompt: request.card.body,
		input: request.card.rawInput,
		choices: request.card.actions,
		requireApproval: request.card.requireApproval,
		requireFeedback: request.card.requireFeedback,
		feedbackPlaceholder: request.card.feedbackPlaceholder,
	}
}

function messageType(event: TaskletEvent): string {
	const communication = event.communication
	if (communication.type === "waiting_for_message") return "waiting_for_message"
	if (communication.type === "message") return communication.message.type
	if (communication.type === "interaction") return requestType(communication.request)
	if (communication.type === "outcome") return "outcome"
	if (communication.type === "lifecycle") return communication.state
	if (communication.response.reply_to) return "reply"
	return communication.response.operation === "complete" ? "completion_attempt" : communication.response.operation
}

function recordedMessage(event: TaskletEvent) {
	const communication = event.communication
	return {
		id: event.id,
		taskletId: event.taskletId,
		createdAt: event.createdAt,
		direction:
			communication.type === "message"
				? "parent_to_child"
				: communication.type === "lifecycle" || communication.type === "outcome"
					? "host_to_parent"
					: "child_to_parent",
		type: messageType(event),
		communication:
			communication.type === "interaction"
				? { type: communication.type, request: pendingRequest(communication.request) }
				: communication,
	}
}

interface RecordedCall {
	block: DiracAssistantToolUseBlock
	ts?: number
}
interface RecordedResult {
	block: DiracUserToolResultContentBlock
	ts?: number
}

function recordedTools(conversation: readonly DiracStorageMessage[]) {
	const calls: RecordedCall[] = []
	const results = new Map<string, RecordedResult[]>()
	for (const message of conversation) {
		if (typeof message.content === "string") continue
		for (const block of message.content) {
			if (block.type === "tool_use") calls.push({ block, ts: message.ts })
			if (block.type !== "tool_result") continue
			const matches = results.get(block.tool_use_id) ?? []
			matches.push({ block, ts: message.ts })
			results.set(block.tool_use_id, matches)
		}
	}
	return { calls, results }
}

function callStatus(results: RecordedResult[] | undefined): "pending" | "failed" | "completed" {
	if (!results?.length) return "pending"
	return results[results.length - 1].block.is_error ? "failed" : "completed"
}

/** Passive projection only: no receipts, waiters, input queues, presentation reads, or model access. */
export async function inspectTasklet(
	source: TaskletInspectionSource,
	query: TaskletInspectionQuery = {},
): Promise<TaskletInspectionPage> {
	validateQuery(query)
	const view = query.view ?? "status"
	const pageQuery = { ...query, view }
	const { inspection, events } = source
	const page = <T>(items: readonly T[]) =>
		pageInspectionItems(items, pageQuery, { taskletId: inspection.id, title: preview(inspection.title, 300), ...(inspection.role === undefined ? {} : { role: inspection.role }) })
	if (view === "status") {
		const lastRecordedCommunicationAt = events.reduce(
			(latest, event) => Math.max(latest, event.createdAt),
			inspection.createdAt,
		)
		return page([{ ...summarizeTasklet(inspection), lastRecordedCommunicationAt }])
	}
	if (view === "messages") {
		const messages = events
			.map(recordedMessage)
			.filter(
				(message) =>
					!query.messageType || message.type === query.messageType || message.communication.type === query.messageType,
			)
		return page(messages)
	}
	if (view === "pending")
		return page(inspection.interactions.filter((request) => request.status === "pending").map(pendingRequest))
	if (view === "assignment") {
		const outcome = inspection.outcomePersisted ? inspection.outcome : undefined
		const outcomeEvent =
			outcome &&
			[...events]
				.reverse()
				.find(
					(event) =>
						event.communication.type === "outcome" &&
						JSON.stringify(event.communication.outcome) === JSON.stringify(outcome),
				)
		return page([
			{
				id: inspection.id,
				outcomePersisted: inspection.outcomePersisted,
				...(outcome ? { outcome } : {}),
				evidence: {
					outcomeEventId: outcomeEvent?.id,
					trajectory: { view: "trajectory" },
					transcript: { view: "transcript" },
				},
			},
		])
	}
	if ((view === "call" || view === "result") && !query.callId)
		throw new Error("Inspection callId is required for the selected view")
	const conversation = await source.readConversation()
	if (view === "transcript") return page(conversation)
	const { calls, results } = recordedTools(conversation)
	if (view === "trajectory") {
		return page(
			calls.map(({ block, ts }) => ({
				callId: block.id,
				name: block.name,
				ts,
				status: callStatus(results.get(block.id)),
				input: preview(JSON.stringify(block.input), 240),
			})),
		)
	}
	if (view === "call") {
		const call = calls.find(({ block }) => block.id === query.callId)
		if (!call) throw new Error(`Unknown recorded tasklet call: ${query.callId}`)
		return page([{ callId: call.block.id, name: call.block.name, ts: call.ts, arguments: call.block.input }])
	}
	const matchingResults = results.get(query.callId!)
	if (matchingResults)
		return page(matchingResults.map((result) => ({ callId: query.callId, ts: result.ts, result: result.block })))
	if (!calls.some(({ block }) => block.id === query.callId)) throw new Error(`Unknown recorded tasklet call: ${query.callId}`)
	return page([{ callId: query.callId, status: "pending" }])
}
