import type { Card, DiracMessage } from "@shared/ExtensionMessage"
import type { ResponseArguments } from "@shared/responseTool"
import type { TaskletUsage, TaskletUsageSnapshot } from "@shared/taskletUsage"
import type { ICardHandle, PermissionOperation } from "../tools/interfaces/ICardHandle"
import type { TaskletConfiguration } from "../TaskletConfiguration"
import type { SerializedTaskError, TaskRunOutcome } from "../TaskRunOutcome"

/** Shared addressed supervision contract; no engine, storage, or presentation implementation dependencies. */
/** Data retained by the owner; presentation is not an authorization decision. */
export interface TaskInteractionRequest {
	card: Readonly<Card>
	permissionRequestKind?: "tool" | "manual_tool"
	permissionOperation?: PermissionOperation
	/** Reason the child's Utility permission evaluation escalated to its owner. */
	utilityPermissionEscalation?: string
	/** Display-only explanation when Utility was not consulted before the owner. */
	utilityPermissionSkipped?: string
	toolCall?: { name: string; arguments: Record<string, unknown> }
}

/** Durable child identity/assignment; an absent outcome means accepted, not completed. */
export interface TaskletRecord {
	/** Exact approvals belong only to this root and stable child identity. */
	commandGrants?: import("../tools/interfaces/CommandApprovals").CommandGrantSnapshot
	configuration?: TaskletConfiguration
	/** Creation-time role; absent only when historical identity did not record one. */
	role?: string
	id: string
	rootTaskId: string
	conversationUlid: string
	title: string
	prompt: string
	createdAt: number
	outcome?: TaskRunOutcome
	/** Lifetime snapshots, replaced rather than added on explicit resumption. */
	usage?: TaskletUsageSnapshot
}

/** Read-only compatibility for retained responses from the former control-question protocol. */
export type RecordedTaskletResponse = ResponseArguments & { reply_to?: string }

/** Historical control records remain readable; these variants are not callable inputs. */
export type RecordedTaskletMessage = TaskletMessage
	| { taskletId: string; type: "question"; text: string }
	| { taskletId: string; type: "reply"; replyTo: string; text?: string; action?: string }
	| { taskletId: string; type: "permission_decision"; replyTo: string; decision: "approve" | "reject" | "escalate" }

export interface TaskletEvent {
	id: string
	taskletId: string
	createdAt: number
	deliveredAt?: number
	communication:
	| { type: "waiting_for_message" }
	| { type: "response"; response: RecordedTaskletResponse }
	| { type: "message"; message: RecordedTaskletMessage }
	| { type: "lifecycle"; state: "accepted" | "resumed"; assignment?: string }
	| { type: "interaction"; request: TaskletInteraction }
	| { type: "outcome"; outcome: TaskRunOutcome }
}

export type TaskletInteractionResult = Awaited<ReturnType<ICardHandle["waitForInteraction"]>>

export interface TaskletInteraction extends TaskInteractionRequest {
	id: string
	status: "pending" | "resolved" | "retired"
	createdAt: number
	retiredAt?: number
	resolvedAt?: number
	resolution?: TaskletInteractionResult
	/** Exact decision retained for idempotent addressed retries. */
	decision?: TaskletInteractionDecision
	kind?: "question" | "permission" | "operational"
}

export interface TaskletInspection extends TaskletRecord {
	responses: RecordedTaskletResponse[]
	interactions: TaskletInteraction[]
	/** Live engine status is informational, never evidence of a committed outcome. */
	executionStatus?: import("@shared/ExtensionMessage").TaskStatus | "waiting_for_message"
	backgroundCommandRunning: boolean
	lastActivityAt?: number
	outcomePersisted: boolean
	settlementError?: SerializedTaskError
	/** Informational projection failure; does not change child outcome or resumption authority. */
	presentationError?: SerializedTaskError
}

export interface TaskletTranscript {
	conversation: import("@shared/messages/content").DiracStorageMessage[]
	presentation: DiracMessage[]
}

export type TaskletInteractionDecision =
	| { operation: "approve" | "reject" | "escalate" }
	| { operation: "answer"; response: TaskletInteractionResult }

export type TaskletResolution = { status: "resolved" | "requires_user_approval" }

/** One addressed direct-message protocol; replies never infer permission from prose. */
export type TaskletMessage =
	| { taskletId: string; type: "guidance"; text: string }
	| { taskletId: string; type: "reply"; requestId: string; text?: string; action?: string }
	| {
		taskletId: string
		type: "permission_decision"
		requestId: string
		decision: "approve" | "reject" | "escalate"
		/** Optional explanation, never permission authority or an expansion of the addressed request. */
		text?: string
	}

export interface TaskletMessageResult {
	taskletId: string
	title?: string
	role?: string
	requestId?: string
	messageId?: string
	request?: string
	status: "queued" | "resolved" | "already_resolved" | "stale" | "requires_user_approval" | "failed"
	error?: string
}

export interface TaskletSleepOptions {
	/** Omit to wake for any child communication; [] selects time/user-input only. */
	taskletIds?: string[]
	/** Optional relative deadline in milliseconds (integer, 0..2147483647). */
	timeoutMs?: number
}

export type TaskletWakeResult =
	| { reason: "event"; taskletId: string; eventId: string }
	| { reason: "mail"; from: string; messageId: string }
	| { reason: "journal"; from: string; messageId: string }
	| { reason: "timeout" | "user_message" | "cancelled" }

export interface TaskletInspectionQuery {
	view?: "status" | "messages" | "pending" | "trajectory" | "call" | "result" | "transcript" | "assignment"
	cursor?: string
	limit?: number
	callId?: string
	messageType?: string
}

export interface TaskletInspectionPage<T = unknown> {
	view?: TaskletInspectionQuery["view"]
	taskletId?: string
	title?: string
	role?: string
	items: T[]
	totalItems: number
	/** Concatenate consecutive JSON fragments, then parse once. Offsets count UTF-16 code units. */
	fragment?: { itemIndex: number; offset: number; totalCharacters: number; totalBytes: number; json: string }
	/** More recorded data is available. Reuse with the same view/filter/call; never a delivery receipt. */
	nextCursor?: string
	/** Messages-only EOF position. Pass as cursor on a later read to receive newly appended messages. */
	tailCursor?: string
}

export interface TaskletSummary {
	id: string
	title: string
	role?: string
	/** Saved task-local command policy; current user ceiling is rechecked at execution. */
	sandboxPolicy?: ReturnType<typeof import("@shared/SandboxTaskPolicy").describeSandboxTaskProfile>
	createdAt: number
	executionStatus?: TaskletInspection["executionStatus"]
	pendingRequestCount: number
	latestProgress?: string
	lastActivityAt?: number
	backgroundCommandRunning: boolean
	outcomePersisted: boolean
	outcome?: { kind: TaskRunOutcome["kind"]; summary: string; at: number }
	settlementError?: { name: string; message: string }
	presentationError?: { name: string; message: string }
	usage?: TaskletUsage
}
