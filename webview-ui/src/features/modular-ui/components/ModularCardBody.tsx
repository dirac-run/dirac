import { Card } from "@shared/ExtensionMessage"
import { formatSubagentTrajectory, readSubagentCardData } from "@shared/subagents"
import { readTaskletPresentation } from "@shared/taskletPresentation"
import React, { useMemo } from "react"
import { CARD_DECORATORS } from "../decorators"
import { CardActions } from "./CardActions"
import { CardContent } from "./CardContent"
import { CommunicationCardBody } from "./CommunicationCardBody"
import { TaskletReceiptBody } from "./TaskletReceiptBody"

interface ModularCardBodyProps {
	card: Card
	isActive?: boolean
	onAction?: (value: string) => void
	scrollRef?: React.Ref<HTMLDivElement>
}

export const SUBAGENT_CARD_MAX_HEIGHT_PX = 320

export function resolveCardBodyPresentation(card: Card): { body?: string; maxHeight?: number } {
	const tasklet = readTaskletPresentation(card)
	if (card.rawInput?.isTasklet === true) {
		return {
			body: tasklet
				? [
						`Assignment\n${tasklet.prompt}`,
						tasklet.result === undefined ? undefined : `Result preview\n${tasklet.result}`,
						tasklet.status === "waiting" ? "Waiting for Dirac." : undefined,
						tasklet.communications.length ? `Messages\n${tasklet.communications.join("\n\n")}` : undefined,
						tasklet.activity.length ? `Activity\n${tasklet.activity.join("\n\n")}` : undefined,
					]
						.filter(Boolean)
						.join("\n\n")
				: card.body,
			maxHeight: SUBAGENT_CARD_MAX_HEIGHT_PX,
		}
	}
	const subagentData = readSubagentCardData(card)
	if (!subagentData) return { body: card.body, maxHeight: card.maxHeight }
	return {
		body: formatSubagentTrajectory(subagentData, { includeToolResults: false }),
		maxHeight: SUBAGENT_CARD_MAX_HEIGHT_PX,
	}
}

export const ModularCardBody: React.FC<ModularCardBodyProps> = ({ card, isActive, onAction, scrollRef }) => {
	const { renderType } = card
	const isTaskletCard = card.rawInput?.isTasklet === true
	const decorators = useMemo(
		() =>
			card.communication || isTaskletCard || card.taskletReceipt ? [] : CARD_DECORATORS.filter((d) => d.shouldApply(card)),
		[card, isTaskletCard],
	)
	const presentation = useMemo(() => resolveCardBodyPresentation(card), [card])
	if (card.communication) return <CommunicationCardBody card={card} />
	if (card.taskletReceipt) {
		return (
			<div className="overflow-y-auto border-t border-foreground/10 p-2.5" ref={scrollRef} style={{ maxHeight: 320 }}>
				<TaskletReceiptBody receipt={card.taskletReceipt} />
			</div>
		)
	}

	// Find the first decorator that provides a body wrapper
	const bodyWrapper = decorators.find((d) => d.renderBodyWrapper)
	const suppressDefaultActions = decorators.some((d) => d.suppressDefaultActions)
	const bodyContent = presentation.body && (
		<div
			className="overflow-x-auto overflow-y-auto p-2.5 text-sm leading-relaxed"
			ref={scrollRef}
			style={{ maxHeight: presentation.maxHeight ? `${presentation.maxHeight}px` : "320px" }}>
			<CardContent
				body={presentation.body}
				messageId={card.id}
				renderType={isTaskletCard ? "text" : renderType}
				streaming={!isTaskletCard && card.status === "running" && presentation.body === card.body}
			/>
		</div>
	)

	return (
		<div className="flex flex-col border-t border-foreground/10">
			{presentation.body && (bodyWrapper ? bodyWrapper.renderBodyWrapper!(card, bodyContent) : bodyContent)}

			{decorators.map((d) => (
				<React.Fragment key={d.id}>{d.renderFooterExtra?.(card, onAction, isActive)}</React.Fragment>
			))}

			{!isTaskletCard && !suppressDefaultActions && <CardActions card={card} isActive={isActive} onAction={onAction} />}
		</div>
	)
}
