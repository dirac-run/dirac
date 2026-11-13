import { styles, theme } from "../constants/theme"
import { Card as CardType } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import React from "react"
import { clipTextToWindow } from "../utils/text-clipping"
import { Markdown } from "./modular-ui/Markdown"
import { cardBodyForDisplay } from "../utils/card-body"
import { CardBody } from "./modular-ui/CardBody"
import { CardHeader } from "./modular-ui/CardHeader"
import { Diff } from "./modular-ui/Diff"

interface PermissionModalProps {
	card: CardType
	scrollOffset: number
	maxScrollOffset: number
	bodyLines: number
	bodyColumns: number
	width: number
	height: number
}

export const PermissionModal: React.FC<PermissionModalProps> = ({
	card,
	scrollOffset,
	maxScrollOffset,
	bodyLines,
	bodyColumns,
	width,
	height,
}) => {
	const body = cardBodyForDisplay(card.body, card.renderType)
	// With separate file diffs, the body describes the request rather than containing a diff.
	const bodyRenderType = card.renderType === "diff" && card.diffs?.length ? "text" : card.renderType
	const visibleBody = bodyRenderType === "text" ? clipTextToWindow(body, bodyLines, bodyColumns, scrollOffset, "… earlier content clipped …").visibleText : body
	const borderColor = card.requireApproval ? theme.warning : theme.status.waiting
	const title = card.requireApproval ? "Permission required" : "Input required"

	return (
		<Box
			borderColor={borderColor}
			borderStyle="round"
			flexDirection="column"
			height={height}
			paddingX={1}
			width={width}>
			<Box flexShrink={0}>
				<Text bold color={borderColor}>
					{title}
				</Text>
			</Box>
			<Box flexDirection="column" flexGrow={1} overflow="hidden">
				<Box flexShrink={0}>
					<CardHeader header={card.header} icon={card.icon} status={card.status} />
				</Box>
				<Box flexDirection="column" marginTop={1}>
					{bodyRenderType === "markdown" ? (
						<Markdown color={styles.tool.body.color} width={bodyColumns} maxLines={bodyLines} scrollOffset={scrollOffset}>{body}</Markdown>
					) : bodyRenderType === "diff" ? (
						<Diff content={body} width={bodyColumns} maxLines={bodyLines} scrollOffset={scrollOffset} />
					) : (
						<CardBody body={visibleBody} renderType={bodyRenderType} renderWidth={bodyColumns} />
					)}
				</Box>
			</Box>
			<Box flexShrink={0}>{renderFooter(card, scrollOffset, maxScrollOffset)}</Box>
		</Box>
	)
}

function renderFooter(card: CardType, scrollOffset: number, maxScrollOffset: number): React.ReactNode {
	const canScrollUp = scrollOffset < maxScrollOffset
	const canScrollDown = scrollOffset > 0

	return (
		<Box flexDirection="column">
			{maxScrollOffset > 0 && (
				<Text color={theme.muted}>
					{canScrollUp ? "↑" : " "} / {canScrollDown ? "↓" : " "} scroll
				</Text>
			)}
			{card.requireApproval && card.commandApprovalChoices ? (
				card.commandApprovalChoices.map((choice, index) => (
					<Text key={choice.id} color={theme.muted}>
						<Text bold color={choice.id === "reject" ? theme.error : theme.info}>{index + 1}</Text>{" "}
						{choice.label}
					</Text>
				))
			) : card.requireApproval && (!card.actions || card.actions.length === 0) ? (
				<Text color={theme.muted}>
					<Text backgroundColor={theme.buttonPrimaryBg} color={theme.buttonPrimaryText}> y </Text> approve{"  "}
					<Text backgroundColor={theme.buttonSecondaryBg} color={theme.buttonSecondaryText}> n </Text> deny
				</Text>
			) : null}
			{card.requireFeedback && card.actions && card.actions.length > 0 && (
				<Text color={theme.muted}>
					{card.actions.map((action, index) => (
						<Text key={action.value || action.label}>
							<Text bold color={action.style === "danger" ? theme.error : theme.info}>
								{index + 1}
							</Text>{" "}
							{action.label}
							{index < card.actions!.length - 1 ? "   " : ""}
						</Text>
					))}
				</Text>
			)}
			{card.requireFeedback && (!card.actions || card.actions.length === 0) && (
				<Text color={theme.muted}>Type response and press Enter</Text>
			)}
		</Box>
	)
}
