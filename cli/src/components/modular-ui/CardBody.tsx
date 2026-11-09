import { RenderType } from "@shared/ExtensionMessage"
import { formatTaskletReceipt, type TaskletReceipt } from "@shared/taskletReceipt"
import { Box, Text } from "ink"
import React, { useMemo } from "react"
import { styles } from "../../constants/theme"
import { cardBodyForDisplay } from "../../utils/card-body"
import { clipMarkdownLines, renderMarkdownLines } from "../../utils/markdown"
import { linkifyPaths } from "../../utils/terminal-link"
import { clipTextToWindow } from "../../utils/text-clipping"
import { Diff } from "./Diff"
import { Markdown } from "./Markdown"
import { TaskletReceiptBody } from "./TaskletReceiptBody"

interface CardBodyProps {
	body?: string
	maxLines?: number
	renderType: RenderType
	scrollOffset?: number
	renderWidth?: number
	stripLineAnchors?: boolean
	previewFromStart?: boolean
	literal?: boolean
	receipt?: TaskletReceipt
}

export const CardBody: React.FC<CardBodyProps> = ({
	body,
	maxLines,
	renderType,
	scrollOffset,
	renderWidth,
	stripLineAnchors = true,
	previewFromStart = false,
	literal = false,
	receipt,
}) => {
	const displayBody = receipt
		? formatTaskletReceipt(receipt)
		: stripLineAnchors
			? cardBodyForDisplay(body, renderType)
			: (body ?? "")
	const columns = Math.max(1, renderWidth ?? (process.stdout.columns || 80) - 6)
	const markdownLines = useMemo(
		() =>
			renderType === "markdown" && maxLines ? renderMarkdownLines(displayBody, columns, styles.tool.body.color) : undefined,
		[displayBody, columns, renderType, maxLines],
	)
	const { visibleText, hasMoreAbove, hasMoreBelow } = maxLines
		? markdownLines
			? clipMarkdownLines(markdownLines, maxLines, scrollOffset ?? 0)
			: clipTextToWindow(displayBody, maxLines, columns, scrollOffset ?? (previewFromStart ? Number.MAX_SAFE_INTEGER : 0))
		: { visibleText: displayBody, hasMoreAbove: false, hasMoreBelow: false }
	if (!displayBody) return null
	if (receipt && !maxLines) return <TaskletReceiptBody receipt={receipt} />
	return (
		<Box flexDirection="column">
			{maxLines || literal ? (
				<Text {...styles.tool.body}>{visibleText}</Text>
			) : (
				renderContent(visibleText, renderType, columns)
			)}
			{(hasMoreAbove || hasMoreBelow) && (
				<Box marginTop={0}>
					<Text {...styles.tool.metadata}>
						{hasMoreAbove ? "↑ " : ""}scroll{hasMoreBelow ? " ↓" : ""}
					</Text>
				</Box>
			)}
		</Box>
	)
}

function renderContent(body: string, renderType: RenderType, width: number): React.ReactNode {
	switch (renderType) {
		case "markdown":
			return (
				<Markdown color={styles.tool.body.color} width={width}>
					{body}
				</Markdown>
			)
		case "diff":
			return <Diff content={body} width={width} />
		case "text":
		default:
			return <Text {...styles.tool.body}>{linkifyPaths(body)}</Text>
	}
}
