import { createHash } from "node:crypto"
import type { Controller } from ".."
import { DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import type { TaskletInventoryRow, TaskletTranscriptPage, TaskletObservedMessage } from "@shared/taskletObservation"
import type { TaskRunOutcome } from "@core/task/TaskRunOutcome"

export const OBSERVATION_PAGE_BYTES = 64 * 1024
const MESSAGE_BYTES = 12 * 1024

/** The selected UI surface is the read boundary, never the Controller.task fallback. */
export function selectedObservation(controller: Controller, rootTaskId: string, sourceId?: string) {
	const source = controller.selectedTaskletObservation()
	if (!source || source.rootTaskId !== rootTaskId)
		throw new Error("Tasklet observation root changed; refresh the selected surface")
	if (sourceId && source.sourceId !== sourceId) throw new Error("Tasklet observation source changed; refresh without a cursor")
	return source
}

export function observationLimit(limit: number | undefined): number {
	if (limit === undefined) return 20
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Observation limit must be between 1 and 50")
	return limit
}

export function observationFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function observationOffset(cursor: string | undefined, scope: string, revision: string): number {
	if (!cursor) return 0
	if (cursor.length > 2048) throw new Error("Invalid tasklet observation cursor")
	const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
	if (!parsed || typeof parsed !== "object") throw new Error("Invalid tasklet observation cursor")
	const value = parsed as { scope?: string; revision?: string; offset?: number }
	if (value.scope !== scope || value.revision !== revision)
		throw new Error("Tasklet observation changed; refresh without a cursor")
	if (!Number.isSafeInteger(value.offset) || value.offset! < 0) throw new Error("Invalid tasklet observation cursor offset")
	return value.offset!
}

export function observationCursor(scope: string, revision: string, offset: number): string {
	return Buffer.from(JSON.stringify({ scope, revision, offset })).toString("base64url")
}

export function outcomeObservation(outcome: TaskRunOutcome | undefined): TaskletTranscriptPage["outcome"] {
	if (!outcome) return undefined
	const summary =
		outcome.kind === "completed"
			? outcome.response
			: outcome.kind === "failed"
				? outcome.error.message
				: (outcome.reason ?? "Cancelled")
	const at =
		outcome.kind === "completed"
			? outcome.completedAt
			: outcome.kind === "failed"
				? outcome.failedAt
				: outcome.kind === "cancelled"
					? outcome.cancelledAt
					: outcome.interruptedAt
	const clipped = clipObservationText(summary, 8000)
	return {
		kind: outcome.kind === "cancelled" ? "interrupted" : outcome.kind,
		summary: clipped,
		at,
		truncated: clipped !== summary,
	}
}


export function savedInventoryRow(record: { id: string; title: string; outcome?: TaskRunOutcome }): TaskletInventoryRow {
	return {
		taskletId: record.id,
		title: clipObservationText(record.title, 512),
		state: record.outcome?.kind === "cancelled" ? "interrupted" : (record.outcome?.kind ?? "unsettled"),
	}
}

export function clipObservationText(value: string, bytes: number): string {
	if (Buffer.byteLength(JSON.stringify(value)) <= bytes) return value
	const suffix = "\n[truncated for observation]"
	let low = 0
	let high = Math.min(value.length, bytes)
	while (low < high) {
		const midpoint = Math.ceil((low + high) / 2)
		if (Buffer.byteLength(JSON.stringify(value.slice(0, midpoint) + suffix)) <= bytes) low = midpoint
		else high = midpoint - 1
	}
	return value.slice(0, low) + suffix
}

/** Whitelist human display fields: no approval, tool arguments, links/actions, or hidden usage. */
export function observedMessage(message: DiracMessage): { message: TaskletObservedMessage; truncated: boolean } | undefined {
	const base = { id: message.id, ts: message.ts }
	if (message.content.type === DiracMessageType.MARKDOWN) {
		const text = clipObservationText(message.content.content, MESSAGE_BYTES)
		return {
			message: {
				...base,
				content: {
					type: DiracMessageType.MARKDOWN,
					content: text,
					role: message.content.role,
					isReasoning: message.content.isReasoning,
				},
			},
			truncated: text !== message.content.content || !!message.content.images?.length || !!message.content.files?.length,
		}
	}
	if (message.content.type !== DiracMessageType.CARD) return undefined
	const card = message.content.card
	if (card.rawInput?.isTasklet || card.rawOutput?.source === "tasklet" || card.rawOutput?.source === "subagents")
		return undefined
	const header = clipObservationText(card.header, 1024)
	const body = clipObservationText(card.body ?? "", MESSAGE_BYTES)
	return {
		message: {
			...base,
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: card.id,
					header,
					body,
					status: card.status,
				},
			},
		},
		truncated: header !== card.header || body !== (card.body ?? "") || !!card.diffs?.length,
	}
}
