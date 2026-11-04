import { CardStatus } from "@shared/ExtensionMessage"
import type { ICardHandle, IToolEnvironment } from "../interfaces/IToolEnvironment"
import { ToolTimeoutError } from "./ToolExecutionDeadline"

export async function presentToolTimeout(
	environment: IToolEnvironment,
	error: ToolTimeoutError,
	cards: readonly ICardHandle[] = [],
): Promise<never> {
	const timeoutCards = [...cards]
	if (timeoutCards.length === 0) {
		timeoutCards.push(
			await environment.ui.createCard({
				header: `Timed out: ${error.toolName}`,
				collapsed: true,
			}),
		)
	}

	for (const card of timeoutCards) {
		await card.update({
			header: `Timed out: ${error.toolName}`,
			status: CardStatus.ERROR,
			body: error.message,
			rawOutput: {
				error: error.message,
				outcome: error.outcome,
				operation: error.operation,
				timeoutMs: error.timeoutMs,
			},
			outcome: error.outcome,
		})
		await card.finalize(CardStatus.ERROR)
	}

	throw error
}
