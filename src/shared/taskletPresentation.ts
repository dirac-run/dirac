import { CardStatus, DiracMessageType, type Card, type DiracMessage } from "./ExtensionMessage"
import type { TaskletUsage } from "./taskletUsage"

export type TaskletPresentationStatus = "running" | "waiting" | "completed" | "failed" | "interrupted"

/** Display-only projection. The owning host retains lifecycle, communications and full results. */
export interface TaskletPresentationData {
	taskletId: string
	title: string
	prompt: string
	createdAt: number
	status: TaskletPresentationStatus
	result?: string
	communications: string[]
	activity: string[]
	usage?: TaskletUsage
}

const PREVIEW_CHARACTERS = 1200
const PREVIEW_ITEMS = 40

function preview(text: string): string {
	return text.length <= PREVIEW_CHARACTERS
		? text
		: `${text.slice(0, PREVIEW_CHARACTERS)}… [preview; inspect tasklet for full contents]`
}

/** Routine child activity is diagnostic; it never becomes a parent-directed request. */
export function taskletActivityPreview(messages: readonly DiracMessage[]): string[] {
	return messages.slice(-PREVIEW_ITEMS).flatMap((message) => {
		if (message.content.type === DiracMessageType.MARKDOWN) return [preview(message.content.content)]
		if (message.content.type === DiracMessageType.CARD) {
			const { header, body, status } = message.content.card
			return [preview(`${header} · ${status}${body ? `\n${body}` : ""}`)]
		}
		return []
	})
}

/** Human projection only; routing identities remain in the owner's structured protocol records. */
export function taskletCommunicationPreview(
	communication:
		| { type: "response"; response: { operation: string; text: string } }
		| { type: "interaction"; request: { status: string; card: Pick<Card, "header" | "body"> } }
		| { type: "message"; message: { type: string; text?: string; decision?: string; action?: string } }
		| { type: "lifecycle"; state: string; assignment?: string }
		| { type: "outcome"; outcome: { kind: string; response?: string; reason?: string; error?: { message: string } } },
): string {
	switch (communication.type) {
		case "response":
			return preview(`${communication.response.operation}: ${communication.response.text}`)
		case "interaction":
			return preview(
				`${communication.request.card.header} · ${communication.request.status}${communication.request.card.body ? `\n${communication.request.card.body}` : ""}`,
			)
		case "message":
			return preview(
				`${communication.message.type}: ${communication.message.text ?? communication.message.decision ?? communication.message.action ?? ""}`,
			)
		case "lifecycle":
			return preview(`${communication.state}${communication.assignment ? `\n${communication.assignment}` : ""}`)
		case "outcome":
			return preview(
				`${communication.outcome.kind}: ${communication.outcome.response ?? communication.outcome.error?.message ?? communication.outcome.reason ?? ""}`,
			)
	}
}

export function createTaskletPresentationCard(data: TaskletPresentationData): Card {
	const bounded: TaskletPresentationData = {
		...data,
		prompt: preview(data.prompt),
		result: data.result === undefined ? undefined : preview(data.result),
		communications: data.communications.slice(-PREVIEW_ITEMS).map(preview),
		activity: data.activity.slice(-PREVIEW_ITEMS).map(preview),
	}
	const status = {
		running: CardStatus.RUNNING,
		waiting: CardStatus.WAITING_FOR_INPUT,
		completed: CardStatus.SUCCESS,
		failed: CardStatus.ERROR,
		interrupted: CardStatus.CANCELLED,
	}[data.status]
	return {
		id: `tasklet:${data.taskletId}`,
		header: data.title,
		status,
		renderType: "text",
		collapsed: true,
		startTime: data.createdAt,
		rawInput: { isTasklet: true, taskletId: data.taskletId },
		rawOutput: { tasklet: bounded },
		body: [
			`${data.title} · ${data.status}`,
			bounded.result,
			data.status === "waiting" ? "Waiting for the parent; no user approval is requested here." : undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
	}
}

export function readTaskletPresentation(card: Card): TaskletPresentationData | undefined {
	if (card.rawInput?.isTasklet !== true) return undefined
	const data = card.rawOutput?.tasklet as TaskletPresentationData | undefined
	if (!data) return undefined
	// Historical cards stored raw (and sometimes truncated) protocol JSON. Do not display routing IDs.
	return {
		...data,
		communications: data.communications.map((text) =>
			text.startsWith('{"type":') ? "Historical communication; the parent can inspect its exact messages." : text,
		),
	}
}
