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
	return text.length <= PREVIEW_CHARACTERS ? text : `${text.slice(0, PREVIEW_CHARACTERS)}… [preview; inspect tasklet for full contents]`
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
			`Tasklet ${data.taskletId} · ${data.status}`,
			bounded.result,
			data.status === "waiting" ? "Waiting for the parent; use tasklets to inspect and resolve or escalate." : undefined,
		].filter(Boolean).join("\n\n"),
	}
}

export function readTaskletPresentation(card: Card): TaskletPresentationData | undefined {
	return card.rawInput?.isTasklet === true ? card.rawOutput?.tasklet as TaskletPresentationData | undefined : undefined
}
