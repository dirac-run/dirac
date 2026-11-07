import { DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import { TASKLET_STATE_LABELS, type TaskletInventoryPage, type TaskletTranscriptPage } from "@shared/taskletObservation"

export interface LocalObservationMessage {
	afterMessageId?: string
	position: number
	message: DiracMessage
}

/** Local display entries never enter presentation replay, controller storage, or model input. */
export function mergeLocalObservations(messages: DiracMessage[], local: readonly LocalObservationMessage[]): DiracMessage[] {
	if (local.length === 0) return messages
	const positions = new Map(messages.map((message, index) => [message.id, index + 1]))
	const inserts = new Map<number, DiracMessage[]>()
	for (const entry of local) {
		const position =
			(entry.afterMessageId ? positions.get(entry.afterMessageId) : 0) ?? Math.min(entry.position, messages.length)
		const bucket = inserts.get(position) ?? []
		bucket.push(entry.message)
		inserts.set(position, bucket)
	}
	const result = [...(inserts.get(0) ?? [])]
	for (let index = 0; index < messages.length; index++) result.push(messages[index], ...(inserts.get(index + 1) ?? []))
	return result
}

export function formatAgentSnapshot(page: TaskletInventoryPage): string {
	const heading = `Agents · snapshot at ${new Date(page.observedAt).toLocaleTimeString()}`
	if (page.availability === "saved")
		return `${heading}\nSaved history — live activity is unavailable. Use /agent to inspect saved transcripts.`
	if (page.totalItems === 0) return `${heading}\nNo active agents.`
	return [
		heading,
		`${page.totalItems} active`,
		...page.items.map((item) => `• ${item.title} · ${TASKLET_STATE_LABELS[item.state]}\n  ${item.taskletId}`),
		page.nextCursor
			? `Showing ${page.items.length} of ${page.totalItems}; use /agent to browse the remaining agents.`
			: undefined,
		"Frozen local snapshot. Ask Dirac to guide, stop, or resume an agent.",
	]
		.filter(Boolean)
		.join("\n")
}

/** Text-only transcript rendering intentionally has no card action or composer path. */
export function formatAgentTranscript(page: TaskletTranscriptPage): string {
	const messages = page.messages.flatMap((message) => {
		if (message.content.type === DiracMessageType.MARKDOWN) {
			return [`${message.content.role === "user" ? "Assignment / input" : "Agent"}: ${message.content.content}`]
		}
		if (message.content.type === DiracMessageType.CARD) {
			const card = message.content.card
			return [`${card.header} · ${card.status}${card.body ? `\n${card.body}` : ""}`]
		}
		return []
	})
	return [
		messages.length ? messages.join("\n\n") : "No recorded presentation on this page.",
		page.truncatedMessageIds.length
			? `${page.truncatedMessageIds.length} oversized message(s) clipped by the read limit.`
			: undefined,
		page.outcome
			? `Recorded result · ${page.outcome.kind}\n${page.outcome.summary}${page.outcome.truncated ? "\n[Result clipped by the read limit]" : ""}`
			: undefined,
	]
		.filter(Boolean)
		.join("\n\n")
}
