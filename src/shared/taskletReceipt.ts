import type { TaskletObservedState } from "./taskletObservation"
import { TASKLET_STATE_LABELS } from "./taskletObservation"

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
	wakeReason?: "event" | "timeout" | "user_message" | "cancelled"
	/** The selected wake sources, not an indication of their completion. */
	waitScope?: "any_tasklet" | "selected_tasklets" | "time_or_user"
	waitSourceCount?: number
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

export function taskletReceiptTitle(receipt: TaskletReceipt): string {
	const operation =
		receipt.operation === "inspect"
			? `Inspect ${VIEW_LABELS[receipt.view ?? "status"]}`
			: TASKLET_RECEIPT_OPERATIONS[receipt.operation].label
	if (receipt.rows.length === 1 && receipt.operation !== "list") return `${operation} · ${receipt.rows[0].title}`
	return receipt.rows.length > 1 && receipt.operation !== "list" ? `${operation} · ${receipt.rows.length}` : operation
}

export function taskletReceiptNote(receipt: TaskletReceipt): string | undefined {
	if (receipt.operation === "spawn" || receipt.operation === "resume") return "Acceptance is not assignment completion."
	if (receipt.rows.some((row) => row.outcome === "queued")) return "Queued for delivery; consumption is not confirmed."
	if (receipt.operation === "sleep") {
		if (!receipt.wakeReason) {
			if (receipt.waitScope === "time_or_user") return "Waiting for a deadline or user input."
			return receipt.waitScope === "selected_tasklets"
				? `Waiting for communication from ${receipt.waitSourceCount} selected agents, a deadline, or user input.`
				: "Waiting for agent communication, a deadline, or user input."
		}
		const reasons = {
			event: "Agent communication",
			timeout: "Deadline reached",
			user_message: "User input",
			cancelled: "Wait cancelled",
		}
		return `${reasons[receipt.wakeReason]}. A wake is not assignment completion.`
	}
	if (receipt.operation === "inspect" || receipt.operation === "list") {
		const count = receipt.fragment ? "Evidence fragment" : `${receipt.returnedCount ?? 0} of ${receipt.totalCount ?? 0} items`
		return `${count}${receipt.hasMore ? " · more available" : ""} · passive read`
	}
	return undefined
}

/** Plain-text fallback for exports and bounded terminal windows; no parsing of body text. */
export function formatTaskletReceipt(receipt: TaskletReceipt): string {
	const rows = receipt.rows.map((row) =>
		[
			`${TASKLET_RECEIPT_OPERATIONS[row.operation].label} · ${row.title} — ${TASKLET_RECEIPT_OUTCOMES[row.outcome].label}`,
			row.observedState ? `Observed: ${TASKLET_STATE_LABELS[row.observedState]}` : undefined,
			row.message,
			row.choice ? `Choice: ${row.choice}` : undefined,
			row.request ? `Request: ${row.request}` : undefined,
			row.decision ? `Decision: ${row.decision} · this request only, within parent authority` : undefined,
			row.error ? `Error: ${row.error}` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
	)
	return [...rows, taskletReceiptNote(receipt), receipt.error ? `Error: ${receipt.error}` : undefined]
		.filter(Boolean)
		.join("\n\n")
}
