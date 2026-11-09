import { isTaskCompletionCard } from "@shared/cardIdentity"
import { type DiracMessage, DiracMessageType, isFinalStatus } from "@shared/ExtensionMessage"
import { readTaskletPresentation } from "@shared/taskletPresentation"
import { cardDisplayBody } from "./card-body"
import { renderMarkdownLines } from "./markdown"
import { estimateVisualLineCount } from "./text-clipping"

const MESSAGE_CONTENT_COLUMNS = 4
const CARD_BODY_COLUMNS = 6

export function estimateTimelineMessageRows(message: DiracMessage, terminalColumns: number, suppressCardBody = false): number {
	if (message.content.type === DiracMessageType.MARKDOWN) {
		if (message.content.isReasoning) return 5
		return estimateTimelineMessageBodyRows(message, terminalColumns, suppressCardBody) + 2
	}

	if (message.content.type === DiracMessageType.CARD) {
		const card = message.content.card
		const bodyRows = estimateTimelineMessageBodyRows(message, terminalColumns, suppressCardBody)
		const interactionRows =
			!card.communication && !isFinalStatus(card.status) && (card.requireFeedback || (card.actions?.length ?? 0) > 0)
				? 1
				: 0
		const taskCompletionChromeRows = !readTaskletPresentation(card) && isTaskCompletionCard(card) ? 4 : 1
		return Math.max(1, taskCompletionChromeRows + bodyRows + interactionRows)
	}

	return 1
}

export function estimateTimelineMessageBodyRows(
	message: DiracMessage,
	terminalColumns: number,
	suppressCardBody = false,
): number {
	if (message.content.type === DiracMessageType.MARKDOWN) {
		return renderMarkdownLines(message.content.content, Math.max(1, terminalColumns - MESSAGE_CONTENT_COLUMNS)).length
	}

	if (message.content.type !== DiracMessageType.CARD || suppressCardBody) return 0
	const body = cardDisplayBody(message.content.card)
	if (!body) return 0
	const width = Math.max(1, terminalColumns - CARD_BODY_COLUMNS)
	return !message.content.card.communication && message.content.card.renderType === "markdown"
		? renderMarkdownLines(body, width).length
		: estimateVisualLineCount(body, width)
}

export function calculateTimelineBodyLineBudget(
	message: DiracMessage,
	totalRowBudget: number,
	terminalColumns: number,
	suppressCardBody = false,
): number {
	const bodyRows = estimateTimelineMessageBodyRows(message, terminalColumns, suppressCardBody)
	if (bodyRows === 0) return 0

	const totalRows = estimateTimelineMessageRows(message, terminalColumns, suppressCardBody)
	const chromeRows = Math.max(0, totalRows - bodyRows)
	const unclippedBodyBudget = totalRowBudget - chromeRows
	if (unclippedBodyBudget >= bodyRows) return bodyRows

	const scrollIndicatorRows = 1
	return Math.max(0, unclippedBodyBudget - scrollIndicatorRows)
}
