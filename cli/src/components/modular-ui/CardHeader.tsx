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
	tasklet?: Pick<TaskletPresentationData, "title" | "taskletId" | "status"> & { width: number }
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

function taskletHeaderText({ title, taskletId, status, width }: NonNullable<CardHeaderProps["tasklet"]>): string {
	const identity = `Tasklet ${taskletId} · ${status}`
	const candidates = [`${title.replace(/\s+/g, " ")} · ${identity}`, identity, `${taskletId} · ${status}`]
	const fitting = candidates.find((text) => stringWidth(text) <= width)
	if (fitting) return fitting

	// Reserve status first, then retain the stable ID's distinguishing suffix.
	const suffixWidth = width - stringWidth(status) - 2
	if (suffixWidth < 1) return status.slice(0, width)
	let suffix = ""
	for (const character of Array.from(taskletId).reverse()) {
		if (stringWidth(character + suffix) > suffixWidth) break
		suffix = character + suffix
	}
	return `…${suffix} ${status}`
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
