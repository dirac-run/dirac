import { CardStatus, type Card } from "@shared/ExtensionMessage"
import { ResponseOperation } from "@shared/responseTool"
import type { TaskletEvent, TaskletInteraction } from "./types/tasklet"
import type { TaskRunOutcome } from "./TaskRunOutcome"

/** Observational child-to-parent communication, never an interaction or permission control. */
export function taskletCommunicationCard(event: Readonly<TaskletEvent>): Card | undefined {
	const base = {
		id: event.id,
		communication: { actor: event.taskletId },
		renderType: "markdown" as const,
		startTime: event.createdAt,
	}
	const communication = event.communication
	if (communication.type === "response") {
		// Historical completion attempts are not evidence of committed settlement.
		if (communication.response.operation !== ResponseOperation.PROGRESS) return undefined
		return {
			...base,
			header: `${event.taskletId} shared an update with Dirac`,
			body: communication.response.text,
			status: CardStatus.SUCCESS,
			endTime: event.createdAt,
		}
	}
	if (communication.type === "interaction") {
		const request = communication.request
		const permission = request.kind === "permission" || request.permissionOperation !== undefined || request.permissionRequestKind !== undefined
		return {
			...base,
			header: permission
				? `${event.taskletId} requested permission from Dirac`
				: `${event.taskletId} asked Dirac a question`,
			body: interactionContent(request, permission),
			status: request.status === "pending" ? CardStatus.RUNNING : request.status === "resolved" ? CardStatus.SUCCESS : CardStatus.CANCELLED,
			endTime: request.resolvedAt ?? request.retiredAt,
		}
	}
	if (communication.type !== "outcome") return undefined
	return {
		...base,
		header: `${event.taskletId} reported a result to Dirac`,
		body: outcomeContent(communication.outcome),
		status: communication.outcome.kind === "completed" ? CardStatus.SUCCESS : communication.outcome.kind === "failed" ? CardStatus.ERROR : CardStatus.CANCELLED,
		endTime: event.createdAt,
	}
}

function interactionContent(request: Readonly<TaskletInteraction>, permission: boolean): string {
	const input = request.card.rawInput
	const text = typeof input?.text === "string" ? input.text : request.card.body ?? request.card.header
	const options = Array.isArray(input?.options) ? input.options.filter((option): option is string => typeof option === "string") : []
	const content = [text, ...options.map((option) => `- ${option}`)].join("\n\n")
	return permission ? `${content}\n\nPermission request only; approval remains with Dirac or the existing user escalation controls.` : content
}

function outcomeContent(outcome: TaskRunOutcome): string {
	if (outcome.kind === "completed") return outcome.response
	if (outcome.kind === "failed") return `${outcome.error.name}: ${outcome.error.message}`
	return outcome.reason ?? "Tasklet cancelled"
}
