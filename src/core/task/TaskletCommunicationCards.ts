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
		collapsed: true,
		startTime: event.createdAt,
	}
	const communication = event.communication
	if (communication.type === "response") {
		// Historical completion attempts are not evidence of committed settlement.
		if (communication.response.operation !== ResponseOperation.PROGRESS) return undefined
		return {
			...base,
			header: `${event.taskletId} · Update`,
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
			header: `${event.taskletId} · ${permission ? "Permission" : "Question"} for Dirac`,
			body: interactionContent(request, permission),
			status: request.status === "pending" ? CardStatus.RUNNING : request.status === "resolved" ? CardStatus.SUCCESS : CardStatus.CANCELLED,
			endTime: request.resolvedAt ?? request.retiredAt,
		}
	}
	if (communication.type !== "outcome") return undefined
	return {
		...base,
		header: `${event.taskletId} · Result`,
		body: outcomeContent(communication.outcome),
		status: communication.outcome.kind === "completed" ? CardStatus.SUCCESS : communication.outcome.kind === "failed" ? CardStatus.ERROR : CardStatus.CANCELLED,
		endTime: event.createdAt,
	}
}

function interactionContent(request: Readonly<TaskletInteraction>, permission: boolean): string {
	const input = request.card.rawInput
	const text = typeof input?.text === "string" ? input.text : request.card.body ?? request.card.header
	if (permission) return permissionContent(request, text)
	const options = Array.isArray(input?.options)
		? input.options.filter((option): option is string => typeof option === "string")
		: request.card.actions?.map((action) => action.label) ?? []
	const answer = request.status === "resolved" ? request.resolution : undefined
	const source = request.decision?.operation === "escalate" ? "User via Dirac" : "Dirac"
	const declined = answer?.response === "reject" || answer?.action === "reject"
	let status = "Retired without an answer"
	if (request.status === "pending") status = "Awaiting Dirac"
	if (request.status === "resolved") status = answer ? "Answered" : "Resolved; answer unavailable"
	if (request.status === "resolved" && declined) status = `${source} declined`
	const selectedAction = answer && answer.action !== "message" && !declined
		? request.card.actions?.find((action) => action.value === answer.action)?.label ?? answer.action : undefined
	const choice = answer?.value ?? selectedAction
	return [
		text,
		options.length ? `Choices:\n${options.map((option) => `- ${option}`).join("\n")}` : undefined,
		`Status: ${status}`,
		answer ? `Answer from ${source}:` : undefined,
		answer?.text,
		choice !== undefined ? `Choice: ${choice}` : undefined,
	].filter((value) => value !== undefined).join("\n\n")
}

function permissionContent(request: Readonly<TaskletInteraction>, text: string): string {
	const operation = request.permissionOperation
	let target: string | undefined
	if (operation?.kind === "commands" && !request.card.body)
		target = operation.commands.map((command) => `\`\`\`bash\n${command}\n\`\`\``).join("\n\n")
	if (operation?.kind === "paths") target = `Paths:\n${operation.paths.join("\n")}`
	if (operation?.kind === "browser") target = `URL: ${operation.url}`
	if ((!operation || operation.kind === "tool") && request.toolCall)
		target = `Tool: ${request.toolCall.name}\n\`\`\`json\n${JSON.stringify(request.toolCall.arguments, null, 2)}\n\`\`\``
	const resolution = request.status === "resolved" ? request.resolution : undefined
	const decision = request.decision?.operation
	let source = "Child request to Dirac"
	if (request.utilityPermissionSkipped) source = "Dirac review (Utility not consulted)"
	if (request.utilityPermissionEscalation) source = "Utility escalation to Dirac"
	if (resolution) source = decision === "escalate" ? "User via Dirac" : "Dirac"
	let status = "Awaiting Dirac; permission not granted"
	if (request.status === "retired") status = "Retired; permission not granted"
	if (request.status === "resolved") status = "Resolved; outcome unavailable"
	if (resolution) status = "Resolved"
	if (resolution?.response === "approve") status = "Approved"
	if (resolution?.response === "reject") status = "Rejected"
	return [
		text,
		target,
		`Status: ${status}`,
		`Source: ${source}`,
		request.utilityPermissionEscalation ? `Reason: ${request.utilityPermissionEscalation}` : undefined,
		request.utilityPermissionSkipped ? `Utility not consulted: ${request.utilityPermissionSkipped}` : undefined,
		decision ? `Decision: ${decision}` : undefined,
		resolution?.text,
		"Observation only; approval remains with Dirac or the existing user escalation controls.",
	].filter((value) => value !== undefined).join("\n\n")
}

function outcomeContent(outcome: TaskRunOutcome): string {
	if (outcome.kind === "completed") return outcome.response
	if (outcome.kind === "failed") return "Assignment failed. See tool result for details."
	return outcome.reason ?? "Tasklet cancelled"
}
