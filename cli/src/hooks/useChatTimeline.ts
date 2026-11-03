import { combineCardSequences } from "@shared/combineCardSequences"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { DiracMessageType, isFinalStatus, type TaskStatus } from "@shared/ExtensionMessage"
import { readTaskletPresentation } from "@shared/taskletPresentation"
import type { Dispatch, SetStateAction } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ChatLayoutRows } from "../utils/chat-layout"
import type { CardBodySuppressionPolicy } from "../utils/quiet-mode"
import {
	calculateTimelineBodyLineBudget,
	estimateTimelineMessageBodyRows,
	estimateTimelineMessageRows,
} from "../utils/timeline-rows"
import { useTranscriptPartition } from "./useTranscriptPartition"

export type TimelineMessageKind = "card" | "markdown" | "reasoning" | "checkpoint"

export interface TimelineMessageItem {
	key: string
	type: "message"
	message: DiracMessage
	kind: TimelineMessageKind
	isCompact?: boolean
	tailOnly?: boolean
	maxContentLines?: number
	scrollOffset?: number
}

export interface TimelineNoticeItem {
	key: string
	type: "notice"
	message: string
}

export interface TimelineHeaderItem {
	key: string
	type: "header"
}

export interface TimelineBoundaryItem {
	key: string
	type: "boundary"
}

export type TimelineStaticItem = TimelineHeaderItem | TimelineMessageItem | TimelineBoundaryItem
export type TimelineDynamicItem = TimelineMessageItem | TimelineNoticeItem | TimelineBoundaryItem

export interface ChatTimelineResult {
	displayMessages: DiracMessage[]
	staticItems: TimelineStaticItem[]
	dynamicItems: TimelineDynamicItem[]
	dynamicScrollMessageId?: string
	dynamicScrollMaxOffset: number
	taskSwitchKey: number
	setTaskSwitchKey: Dispatch<SetStateAction<number>>
}

interface ChatTimelineOptions {
	messages: DiracMessage[]
	activeVoiceStreamId?: string
	isApiRequestActive?: boolean
	taskStatus?: TaskStatus
	showHeader: boolean
	layoutRows: ChatLayoutRows
	terminalColumns: number
	scrollFromTop?: number
	shouldSuppressCardBody: CardBodySuppressionPolicy
}

interface DynamicTimelinePlan {
	items: TimelineDynamicItem[]
	scrollMessageId?: string
	maxScrollOffset: number
}

export function useChatTimeline({
	messages,
	activeVoiceStreamId,
	showHeader,
	layoutRows,
	terminalColumns,
	scrollFromTop = 0,
	shouldSuppressCardBody,
}: ChatTimelineOptions): ChatTimelineResult {
	const [taskSwitchKey, setTaskSwitchKey] = useState(0)
	const prevFirstMessageId = useRef<string | null>(null)

	const displayMessages = useMemo(() => prepareTranscriptMessages(messages), [messages])

	const firstMessageId = displayMessages[0]?.id ?? null
	useEffect(() => {
		if (prevFirstMessageId.current !== null && firstMessageId !== null && prevFirstMessageId.current !== firstMessageId) {
			setTaskSwitchKey((key) => key + 1)
		}
		prevFirstMessageId.current = firstMessageId
	}, [firstMessageId])

	const isMessageMutable = (message: DiracMessage) => isMutableTimelineMessage(message, activeVoiceStreamId)
	const estimateRows = (message: DiracMessage) =>
		estimateTimelineMessageRows(message, terminalColumns, shouldSuppressCardBody(message))
	const { staticPrefix, dynamicTail } = useTranscriptPartition(
		displayMessages,
		isMessageMutable,
		firstMessageId ?? undefined,
		{
			rowBudget: layoutRows.activeContentRows,
			estimateRows,
		},
		{
			key: (message) => (message.content.type === DiracMessageType.CARD ? message.content.card.id : message.id),
			revision: (message) =>
				message.content.type === DiracMessageType.CARD && readTaskletPresentation(message.content.card)
					? JSON.stringify(message.content.card)
					: undefined,
		},
	)

	const staticItems = useMemo(() => createStaticTimelineItems(staticPrefix, showHeader), [staticPrefix, showHeader])

	const dynamicPlan = useMemo(
		() =>
			createDynamicTimelineItems(
				dynamicTail,
				activeVoiceStreamId,
				layoutRows,
				terminalColumns,
				scrollFromTop,
				shouldSuppressCardBody,
			),
		[dynamicTail, activeVoiceStreamId, layoutRows, terminalColumns, scrollFromTop, shouldSuppressCardBody],
	)

	return {
		displayMessages,
		staticItems,
		dynamicItems: dynamicPlan.items,
		dynamicScrollMessageId: dynamicPlan.scrollMessageId,
		dynamicScrollMaxOffset: dynamicPlan.maxScrollOffset,
		taskSwitchKey,
		setTaskSwitchKey,
	}
}

export function prepareTranscriptMessages(messages: DiracMessage[]): DiracMessage[] {
	const transcriptMessages = messages.filter((message) => message.content?.type !== DiracMessageType.API_STATUS)
	return combineCardSequences(transcriptMessages)
}

function createStaticTimelineItems(staticMessages: DiracMessage[], showHeader: boolean): TimelineStaticItem[] {
	const items: TimelineStaticItem[] = []

	if (showHeader) {
		items.push({ key: "header", type: "header" })
	}

	items.push(...createTurnSeparatedMessageItems(staticMessages, "static"))
	return items
}

export function createDynamicTimelineItems(
	dynamicMessages: DiracMessage[],
	_activeVoiceStreamId: string | undefined,
	layoutRows: ChatLayoutRows,
	terminalColumns: number,
	scrollFromTop = 0,
	shouldSuppressCardBody: CardBodySuppressionPolicy,
): DynamicTimelinePlan {
	if (dynamicMessages.length === 0) return { items: [], maxScrollOffset: 0 }

	const rowBudget = Math.max(1, layoutRows.activeContentRows)
	const latestMessage = dynamicMessages[dynamicMessages.length - 1]
	const latestRows = estimateMessageRows(latestMessage, terminalColumns, shouldSuppressCardBody)
	if (latestRows >= rowBudget) {
		return createExclusiveMessagePlan(latestMessage, rowBudget, terminalColumns, scrollFromTop, shouldSuppressCardBody)
	}

	let remainingRows = rowBudget
	const allocations: Array<{ message: DiracMessage; rows: number; partial: boolean }> = []
	for (let index = dynamicMessages.length - 1; index >= 0 && remainingRows > 0; index--) {
		const message = dynamicMessages[index]
		const messageRows = estimateMessageRows(message, terminalColumns, shouldSuppressCardBody)
		const allocatedRows = Math.min(messageRows, remainingRows)
		allocations.push({ message, rows: allocatedRows, partial: allocatedRows < messageRows })
		remainingRows -= allocatedRows
	}

	allocations.reverse()
	return {
		items: allocations.map(({ message, rows, partial }) =>
			createProjectedMessageItem(message, rows, terminalColumns, partial, shouldSuppressCardBody),
		),
		maxScrollOffset: 0,
	}
}

function createExclusiveMessagePlan(
	message: DiracMessage,
	rowBudget: number,
	terminalColumns: number,
	scrollFromTop: number,
	shouldSuppressCardBody: CardBodySuppressionPolicy,
): DynamicTimelinePlan {
	const suppressCardBody = shouldSuppressCardBody(message)
	const bodyRows = estimateTimelineMessageBodyRows(message, terminalColumns, suppressCardBody)
	const bodyLineBudget = calculateTimelineBodyLineBudget(message, rowBudget, terminalColumns, suppressCardBody)
	if (bodyRows === 0 || bodyLineBudget <= 0) {
		return {
			items: [{ ...createMessageItem(message), isCompact: true }],
			maxScrollOffset: 0,
		}
	}

	const maxScrollOffset = Math.max(0, bodyRows - bodyLineBudget)
	return {
		items: [
			{
				...createMessageItem(message),
				maxContentLines: bodyLineBudget,
				// The clipping renderer measures from the bottom; the viewport is anchored at the top.
				scrollOffset: Math.max(0, maxScrollOffset - scrollFromTop),
			},
		],
		scrollMessageId: maxScrollOffset > 0 ? message.id : undefined,
		maxScrollOffset,
	}
}

function createProjectedMessageItem(
	message: DiracMessage,
	allocatedRows: number,
	terminalColumns: number,
	partial: boolean,
	shouldSuppressCardBody: CardBodySuppressionPolicy,
): TimelineMessageItem {
	if (partial) {
		return {
			...createMessageItem(message),
			tailOnly: true,
			maxContentLines: allocatedRows,
		}
	}

	const suppressCardBody = shouldSuppressCardBody(message)
	const bodyRows = estimateTimelineMessageBodyRows(message, terminalColumns, suppressCardBody)
	return {
		...createMessageItem(message),
		maxContentLines: bodyRows > 0 ? bodyRows : undefined,
	}
}

function estimateMessageRows(
	message: DiracMessage,
	terminalColumns: number,
	shouldSuppressCardBody: CardBodySuppressionPolicy,
): number {
	return estimateTimelineMessageRows(message, terminalColumns, shouldSuppressCardBody(message))
}

function isMutableTimelineMessage(message: DiracMessage, activeVoiceStreamId: string | undefined): boolean {
	if (message.id === activeVoiceStreamId) return true
	return message.content.type === DiracMessageType.CARD && !isFinalStatus(message.content.card.status)
}

function createTurnSeparatedMessageItems(
	messages: DiracMessage[],
	keyPrefix: string,
): Array<TimelineMessageItem | TimelineBoundaryItem> {
	const items: Array<TimelineMessageItem | TimelineBoundaryItem> = []
	let hasRenderedMessage = false

	for (const [index, message] of messages.entries()) {
		if (hasRenderedMessage && startsNewChatTurn(message)) {
			items.push({ key: `${keyPrefix}-turn-boundary-${index}-${message.id}`, type: "boundary" })
		}

		items.push({ ...createMessageItem(message), key: `${keyPrefix}-${index}-${message.id}` })
		hasRenderedMessage = true
	}

	return items
}

function startsNewChatTurn(message: DiracMessage): boolean {
	if (message.content.type !== DiracMessageType.MARKDOWN) return false
	return message.content.role === "user" && !message.content.isReasoning
}

function createMessageItem(message: DiracMessage): TimelineMessageItem {
	return {
		key: message.id,
		type: "message",
		message,
		kind: getMessageKind(message),
	}
}

function getMessageKind(message: DiracMessage): TimelineMessageKind {
	if (message.content.type === DiracMessageType.MARKDOWN) {
		return message.content.isReasoning ? "reasoning" : "markdown"
	}

	if (message.content.type === DiracMessageType.CARD) {
		return "card"
	}

	return "checkpoint"
}
