import { CardStatus, isFinalStatus, type Card } from "@shared/ExtensionMessage"
import { toError } from "@shared/errors"
import { DiracIcon } from "@shared/icons"
import type { CardParams, ICardHandle, IToolEnvironment } from "../interfaces/IToolEnvironment"

interface GoalTaskAction<T> {
	initial: CardParams
	completed(result: T): Partial<Omit<Card, "id">>
	failureHeader: string
	operation(): Promise<T>
}

/** Runs one Goal child action while keeping its transcript card terminal on every exit path. */
export async function runGoalTaskActionCard<T>(environment: IToolEnvironment, action: GoalTaskAction<T>): Promise<T> {
	const card = await environment.ui.createCard({
		icon: DiracIcon.SUBAGENTS,
		renderType: "markdown",
		collapsed: true,
		...action.initial,
	})

	try {
		const result = await action.operation()
		await card.update(action.completed(result))
		await card.finalize(CardStatus.SUCCESS)
		return result
	} catch (error) {
		return finalizeFailedGoalTaskAction(environment, card, action.failureHeader, toError(error))
	}
}

async function finalizeFailedGoalTaskAction(
	environment: IToolEnvironment,
	card: ICardHandle,
	failureHeader: string,
	actionError: Error,
): Promise<never> {
	if (isFinalStatus(card.status)) throw actionError
	const status = environment.orchestration.getTaskState("abortSignal").aborted
		? CardStatus.CANCELLED
		: CardStatus.ERROR
	try {
		await card.update({
			header: failureHeader,
			body: `${card.body ? `${card.body}\n\n` : ""}**Error:** ${actionError.message}`,
			rawOutput: { error: actionError.message },
		})
		await card.finalize(status)
	} catch (presentationError) {
		throw new AggregateError([actionError, presentationError], `${failureHeader} and its card could not be finalized`)
	}
	throw actionError
}

export function pendingGoalTaskCardBody(
	taskTitleOrId: string,
	detail?: { label: string; markdown: string },
): string {
	const lines = [`**Task:** ${taskTitleOrId}`]
	if (detail) lines.push("", `**${detail.label}:**`, detail.markdown)
	return lines.join("\n")
}
