import { CardStatus } from "@shared/ExtensionMessage"
import type { TaskletPresentationData } from "@shared/taskletPresentation"
import { Text } from "ink"
import Spinner from "ink-spinner"
import React from "react"
import stringWidth from "string-width"
import { styles } from "../../constants/theme"
import { getIcon, getIconCategoryColor, getStatusColor, getStatusIcon } from "../../utils/icon-mapping"

interface CardHeaderProps {
	header: string
	status: CardStatus
	icon?: string
	isCollapsed?: boolean
	compact?: boolean
	statusLabel?: string
	tasklet?: Pick<TaskletPresentationData, "title" | "status"> & { width: number }
}

function getHeaderPresentation(status: CardStatus) {
	switch (status) {
		case CardStatus.ERROR:
		case CardStatus.CANCELLED:
			return styles.tool.errorHeader
		case CardStatus.WAITING_FOR_INPUT:
			return styles.tool.attentionHeader
		case CardStatus.RUNNING:
		case CardStatus.BUILDING:
			return styles.tool.activeHeader
		default:
			return styles.tool.header
	}
}

function taskletHeaderText({ title, status, width }: NonNullable<CardHeaderProps["tasklet"]>): string {
	const normalized = title.replace(/\s+/g, " ").trim()
	const full = `${normalized} · ${status}`
	if (stringWidth(full) <= width) return full
	const titleWidth = width - stringWidth(status) - 3
	if (titleWidth < 1) return status.slice(0, Math.max(0, width))
	let clipped = ""
	for (const character of normalized) {
		if (stringWidth(`${clipped}${character}…`) > titleWidth) break
		clipped += character
	}
	return `${clipped}… · ${status}`
}

export const CardHeader: React.FC<CardHeaderProps> = ({ header, status, icon, compact, statusLabel, tasklet }) => {
	const statusColor = getStatusColor(status)
	const categoryColor = getIconCategoryColor(icon)
	const statusIcon = getStatusIcon(status)
	const isRunning = status === CardStatus.RUNNING || status === CardStatus.BUILDING
	const headerPresentation = getHeaderPresentation(status)
	const displayStatus = statusLabel ?? status.toLowerCase().replaceAll("_", " ")
	const headerColor = headerPresentation.color
	const headerBold = "bold" in headerPresentation ? headerPresentation.bold : false

	// Timeline tasklet chrome is always budgeted as one row, including quiet/partial cards.
	if (tasklet) {
		return (
			<Text bold={headerBold} color={headerColor} wrap="truncate-end">
				{taskletHeaderText(tasklet)}
			</Text>
		)
	}

	if (compact) {
		return (
			<Text>
				<Text color={categoryColor}>{getIcon(icon)}</Text>{" "}
				<Text bold={headerBold}>
					<Text color={headerColor}>{header}</Text>
				</Text>{" "}
				<Text color={statusColor}>{isRunning ? <Spinner type="dots" /> : statusIcon}</Text>
			</Text>
		)
	}

	return (
		<Text>
			<Text color={categoryColor}>{getIcon(icon)}</Text>{" "}
			<Text bold={headerBold}>
				<Text color={headerColor}>{header}</Text>
			</Text>{" "}
			<Text color={statusColor}>{isRunning ? <Spinner type="dots" /> : statusIcon}</Text>{" "}
			{displayStatus && <Text {...styles.tool.metadata}>{displayStatus}</Text>}
		</Text>
	)
}
