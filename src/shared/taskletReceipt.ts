import type { TaskletObservedState } from "./taskletObservation"
import { TASKLET_STATE_LABELS } from "./taskletObservation"
import { formatAgentLabel, formatTaskletLabel } from "./taskletLabel"

/** A frozen operation receipt, never the live execution state of a child. */
export type TaskletReceiptOperation =
	| "spawn"
	| "list"
	| "inspect"
	| "message"
	| "guidance"
	| "question"
	| "reply"
	| "permission_decision"
	| "interrupt"
	| "resume"
	| "sleep"

export type TaskletReceiptOutcome =
	| "requested"
	| "retrieved"
	| "accepted"
	| "queued"
	| "resolved"
	| "already_resolved"
	| "requires_user_approval"
	| "stale"
	| "failed"
	| "partial_failure"
	| "settled"
	| "woke"
	| "cancelled"
	| "recorded"

export type TaskletReceiptView =
	| "status"
	| "messages"
	| "pending"
	| "trajectory"
	| "call"
	| "result"
	| "transcript"
	| "assignment"
export type TaskletReceiptTone = "neutral" | "info" | "success" | "warning" | "error"

export interface TaskletReceiptRow {
	operation: TaskletReceiptOperation
	taskletId?: string
	title: string
	role?: string
	outcome: TaskletReceiptOutcome
	/** The observed child state is separate from the result of this operation. */
	observedState?: TaskletObservedState
	message?: string
	choice?: string
	request?: string
	requestId?: string
	decision?: "approve" | "reject" | "escalate"
	error?: string
}

export interface TaskletReceipt {
	operation: TaskletReceiptOperation
	outcome: TaskletReceiptOutcome
	view?: TaskletReceiptView
	rows: TaskletReceiptRow[]
	returnedCount?: number
	totalCount?: number
	hasMore?: boolean
	fragment?: boolean
	wakeReason?: "event" | "mail" | "journal" | "timeout" | "user_message" | "cancelled"
	/** The selected wake sources, not an indication of their completion. */
	waitScope?: "any_tasklet" | "selected_tasklets" | "time_or_user"
	waitSourceCount?: number
	waitSourceIds?: string[]
	error?: string
}

export const TASKLET_RECEIPT_OPERATIONS: Record<TaskletReceiptOperation, { label: string; icon: string }> = {
	spawn: { label: "Start agents", icon: "users" },
	list: { label: "Agent inventory", icon: "list-tree" },
	inspect: { label: "Inspect", icon: "eye" },
	message: { label: "Message agents", icon: "message-square" },
	guidance: { label: "Send guidance", icon: "message-square" },
	question: { label: "Ask agent", icon: "help-circle" },
	reply: { label: "Reply to agent", icon: "message-square-quote" },
	permission_decision: { label: "Permission decision", icon: "shield-check" },
	interrupt: { label: "Interrupt agent", icon: "stop-circle" },
	resume: { label: "Resume agent", icon: "play" },
	sleep: { label: "Wait for agents", icon: "clock" },
}

export const TASKLET_RECEIPT_OUTCOMES: Record<TaskletReceiptOutcome, { label: string; tone: TaskletReceiptTone }> = {
	requested: { label: "Requested", tone: "neutral" },
	retrieved: { label: "Retrieved", tone: "success" },
	accepted: { label: "Accepted", tone: "info" },
	queued: { label: "Queued", tone: "info" },
	resolved: { label: "Resolved", tone: "success" },
	already_resolved: { label: "Already resolved", tone: "neutral" },
	requires_user_approval: { label: "User approval needed", tone: "warning" },
	stale: { label: "Stale request", tone: "error" },
	failed: { label: "Failed", tone: "error" },
	partial_failure: { label: "Partial failure", tone: "warning" },
	settled: { label: "Settled", tone: "success" },
	woke: { label: "Awake", tone: "info" },
	cancelled: { label: "Cancelled", tone: "neutral" },
	recorded: { label: "Recorded", tone: "neutral" },
}

const VIEW_LABELS: Record<TaskletReceiptView, string> = {
	status: "status",
	messages: "messages",
	pending: "pending requests",
	trajectory: "activity",
	call: "tool call",
	result: "tool result",
	transcript: "transcript",
	assignment: "assignment result",
}

/** Show the same stable conversation ID used by creation and supervision, separate from its assignment. */
export function taskletReceiptRowTitle(row: Pick<TaskletReceiptRow, "taskletId" | "title" | "role">): string {
	return formatTaskletLabel(row)
}

export function taskletReceiptTitle(receipt: TaskletReceipt, actor?: string, actorRole?: string): string {
	if (actor) return taskletActionTitle(receipt, formatAgentLabel({ id: actor, role: actorRole }))
	const operation = receipt.operation === "inspect"
		? `Inspect ${VIEW_LABELS[receipt.view ?? "status"]}`
		: TASKLET_RECEIPT_OPERATIONS[receipt.operation].label
	if (receipt.operation === "list" || receipt.rows.length === 0) return operation
	if (receipt.rows.length === 1) {
		const row = receipt.rows[0]
		return `${operation} · ${formatAgentLabel({ id: row.taskletId ?? "agent", role: row.role })}`
	}
	return `${operation} · ${receipt.rows.length} agents`
}

function taskletActionTitle(receipt: TaskletReceipt, actor: string): string {
	const targets = [...new Set(receipt.rows.map((row) => row.taskletId).filter((id): id is string => id !== undefined))]
	const target = targets.length === 1
		? formatAgentLabel({ id: targets[0], role: receipt.rows.find((row) => row.taskletId === targets[0])?.role })
		: targets.length > 1 ? `${targets.length} agents` : undefined
	const labels: Record<TaskletReceiptOperation, string> = {
		spawn: "Start agents",
		list: "Agents",
		inspect: `Inspect ${VIEW_LABELS[receipt.view ?? "status"]}`,
		message: "Messages",
		guidance: "Guidance",
		question: "Question",
		reply: "Answer",
		permission_decision: "Permission decision",
		interrupt: "Interrupt",
		resume: "Resume",
		sleep: "Awaiting agents",
	}
	if (receipt.operation === "sleep") {
		const sources = receipt.waitSourceIds
		const source = sources?.length === 1
			? formatAgentLabel({ id: sources[0], role: receipt.rows.find((row) => row.taskletId === sources[0])?.role })
			: receipt.waitScope === "time_or_user" ? "deadline or user" : "agents"
		return `${actor} · ${receipt.outcome === "requested" ? `Awaiting ${source}` : "Wait ended"}`
	}
	if (receipt.operation === "list") return `${actor} · ${labels.list}`
	return target ? `${actor} → ${target} · ${labels[receipt.operation]}` : `${actor} · ${labels[receipt.operation]}`
}

export function taskletReceiptNote(receipt: TaskletReceipt): string | undefined {
	if (receipt.operation === "sleep") {
		if (receipt.outcome === "failed") return "Wait failed."
		if (receipt.outcome === "cancelled") return "Wait cancelled."
		if (!receipt.wakeReason) {
			if (receipt.waitScope === "time_or_user") return "Waiting for timeout or user input."
			return receipt.waitScope === "selected_tasklets"
				? `Waiting for messages from ${receipt.waitSourceCount} agents.`
				: "Waiting for agent messages."
		}
		const reasons = {
			event: "Agent update received",
			mail: "Agent message received",
			journal: "Journal notification received",
			timeout: "Deadline reached",
			user_message: "User input received",
			cancelled: "Wait cancelled",
		}
		return `${reasons[receipt.wakeReason]}.`
	}
	if (receipt.operation === "inspect" || receipt.operation === "list") {
		const count = receipt.fragment ? "Evidence fragment" : `${receipt.returnedCount ?? 0} of ${receipt.totalCount ?? 0} items`
		return `${count}${receipt.hasMore ? " · more available" : ""}`
	}
	return undefined
}

/** Plain-text fallback for exports and bounded terminal windows; no parsing of body text. */
export function formatTaskletReceipt(receipt: TaskletReceipt, communicationContent = false): string {
	if (communicationContent && receipt.operation === "list") {
		const roster = receipt.rows.map(
			(row) => `${taskletReceiptRowTitle(row)} — ${row.observedState ? TASKLET_STATE_LABELS[row.observedState] : "State unavailable"}`,
		)
		return [
			receipt.outcome === "failed" ? "Subagent roster unavailable." : roster.length ? roster.join("\n") : "No subagents found.",
			taskletReceiptNote(receipt),
			receipt.error ? "Error: Agent inventory unavailable. See tool result for details." : undefined,
		].filter(Boolean).join("\n\n")
	}
	const rows = receipt.rows.map((row) => {
		const permissionNotice = row.operation !== "permission_decision" ? undefined
			: row.outcome === "requires_user_approval"
				? "User approval required; permission not granted."
				: row.outcome === "resolved" && row.decision === "escalate"
					? "User escalation resolved."
					: undefined
		return [
			row.message,
			row.choice !== undefined ? `Choice: ${row.choice}` : undefined,
			communicationContent
				? ["spawn", "resume", "interrupt", "inspect"].includes(row.operation) ? taskletReceiptRowTitle(row) : undefined
				: `${TASKLET_RECEIPT_OPERATIONS[row.operation].label} · ${taskletReceiptRowTitle(row)}`,
			communicationContent ? undefined : `Status: ${TASKLET_RECEIPT_OUTCOMES[row.outcome].label}`,
			row.observedState ? `Observed: ${TASKLET_STATE_LABELS[row.observedState]}` : undefined,
			row.request ? `Request: ${row.request}` : undefined,
			row.decision ? `Requested decision: ${row.decision}` : undefined,
			permissionNotice,
			row.error ? "Error: Operation failed. See tool result for details." : undefined,
		].filter((value) => value !== undefined).join("\n\n")
	})
	return [
		...rows,
		taskletReceiptNote(receipt),
		receipt.operation === "sleep" && receipt.waitSourceIds?.length ? `Agents: ${receipt.waitSourceIds.join(", ")}` : undefined,
		receipt.error && !receipt.rows.some((row) => row.error) ? "Error: Operation failed. See tool result for details." : undefined,
	].filter(Boolean).join("\n\n")
}
