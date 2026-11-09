import type { TaskletObservedState } from "./taskletObservation"
import { TASKLET_STATE_LABELS } from "./taskletObservation"
import { formatTaskletLabel } from "./taskletLabel"

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

export function taskletReceiptTitle(receipt: TaskletReceipt, actor?: string): string {
	if (actor) return taskletActionTitle(receipt, actor)
	const operation =
		receipt.operation === "inspect"
			? `Inspect ${VIEW_LABELS[receipt.view ?? "status"]}`
			: TASKLET_RECEIPT_OPERATIONS[receipt.operation].label
	if (receipt.rows.length === 1 && receipt.operation !== "list")
		return `${operation} · ${taskletReceiptRowTitle(receipt.rows[0])}`
	return receipt.rows.length > 1 && receipt.operation !== "list" ? `${operation} · ${receipt.rows.length}` : operation
}

function taskletActionTitle(receipt: TaskletReceipt, actor: string): string {
	const targets = receipt.rows.map(taskletReceiptRowTitle).join(", ")
	const failed = receipt.outcome === "failed" || receipt.outcome === "stale"
	const requested = receipt.outcome === "requested"
	const verb = (base: string, ongoing: string, completed: string) =>
		failed ? `failed to ${base}` : requested ? `is ${ongoing}` : completed
	switch (receipt.operation) {
		case "spawn":
			return `${actor} ${receipt.outcome === "partial_failure" ? "partially started" : verb("start", "starting", "started")} ${targets || "subagents"}`
		case "list":
			return `${actor} ${verb("list", "listing", "listed")} subagents`
		case "inspect":
			return `${actor} ${verb("inspect", "inspecting", "inspected")} ${VIEW_LABELS[receipt.view ?? "status"]} of ${targets}`
		case "guidance":
			return `${actor} ${verb("send guidance", "sending guidance", "sent guidance")} to ${targets}`
		case "reply":
			if (receipt.outcome === "already_resolved")
				return `${actor} found ${receipt.rows[0].taskletId ?? receipt.rows[0].title}'s request already resolved`
			return `${actor} ${verb("reply", "replying", "replied")} to ${targets}`
		case "permission_decision": {
			const row = receipt.rows[0]
			const child = row.taskletId ?? row.title
			if (receipt.outcome === "requires_user_approval") return `${actor} requested user approval for ${child}'s request`
			if (receipt.outcome === "already_resolved") return `${actor} found ${child}'s request already resolved`
			const decisions = {
				approve: ["approve", "approving", "approved"],
				reject: ["reject", "rejecting", "rejected"],
				escalate: ["escalate", "escalating", "escalated"],
			} as const
			const decision = decisions[row.decision!]
			return `${actor} ${verb(decision[0], decision[1], decision[2])} ${child}'s request`
		}
		case "interrupt":
			return `${actor} ${verb("interrupt", "interrupting", "requested interruption of")} ${targets}`
		case "resume":
			return `${actor} ${verb("resume", "resuming", "resumed")} ${targets}`
		case "sleep": {
			const sources = receipt.waitSourceIds?.length
				? receipt.waitSourceIds.join(", ")
				: receipt.waitScope === "time_or_user"
					? "a deadline or user input"
					: "subagent communication"
			if (receipt.outcome === "cancelled") return `${actor}'s wait for ${sources} was cancelled`
			return `${actor} ${verb("wait", "waiting", "waited")} for ${sources}`
		}
		case "question":
			return `${actor} ${verb("ask", "asking", "asked")} ${targets}`
		case "message":
			return receipt.rows
				.map((row) =>
					taskletActionTitle({ ...receipt, operation: row.operation, outcome: row.outcome, rows: [row] }, actor),
				)
				.join("; ")
	}
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
			mail: "Ordinary agent message",
			journal: "Journal notification",
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
export function formatTaskletReceipt(receipt: TaskletReceipt, communicationContent = false): string {
	if (communicationContent && receipt.rows.length === 1) {
		const row = receipt.rows[0]
		if (receipt.operation === "guidance") return row.message ?? ""
		if (receipt.operation === "reply") return [row.message, row.choice].filter((value) => value !== undefined).join("\n")
		if (receipt.operation === "permission_decision") {
			const authority =
				row.outcome === "requires_user_approval"
					? "User approval is required; this decision did not grant permission."
					: row.decision === "escalate"
						? "Escalation does not grant permission; user approval is still required."
						: "This request only, within parent authority."
			return [`Decision: ${row.decision}`, `Request: ${row.requestId}`, authority].join("\n")
		}
	}
	if (communicationContent && receipt.operation === "list") {
		const roster = receipt.rows.map(
			(row) =>
				`${taskletReceiptRowTitle(row)} — ${row.observedState ? TASKLET_STATE_LABELS[row.observedState] : "State unavailable"}`,
		)
		return [
			receipt.outcome === "failed"
				? "Subagent roster unavailable."
				: roster.length
					? roster.join("\n")
					: "No subagents found.",
			taskletReceiptNote(receipt),
			receipt.error ? `Error: ${receipt.error}` : undefined,
		]
			.filter(Boolean)
			.join("\n\n")
	}
	const rows = receipt.rows.map((row) =>
		[
			`${TASKLET_RECEIPT_OPERATIONS[row.operation].label} · ${taskletReceiptRowTitle(row)} — ${TASKLET_RECEIPT_OUTCOMES[row.outcome].label}`,
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
