import { CardStatus } from "@shared/ExtensionMessage"
import type { TaskletPresentationData } from "@shared/taskletPresentation"
import { formatTaskletLabel } from "@shared/taskletLabel"
import {
	TASKLET_RECEIPT_OPERATIONS,
	TASKLET_RECEIPT_OUTCOMES,
	taskletReceiptTitle,
	type TaskletReceipt,
} from "@shared/taskletReceipt"
import { Text } from "ink"
import Spinner from "ink-spinner"
import React from "react"
import stringWidth from "string-width"
import { styles } from "../../constants/theme"
import { getIcon, getIconCategoryColor, getStatusColor, getStatusIcon } from "../../utils/icon-mapping"
import { taskletReceiptColor } from "./TaskletReceiptBody"

interface CardHeaderProps {
	header: string
	status: CardStatus
	icon?: string
	isCollapsed?: boolean
	compact?: boolean
	statusLabel?: string
	tasklet?: Pick<TaskletPresentationData, "taskletId" | "title" | "role" | "status"> & { width: number }
	receipt?: TaskletReceipt
	renderWidth?: number
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

function taskletHeaderText({ taskletId, title, role, status, width }: NonNullable<CardHeaderProps["tasklet"]>): string {
	const normalized = formatTaskletLabel({ taskletId, title, role }).replace(/\s+/g, " ").trim()
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

export const CardHeader: React.FC<CardHeaderProps> = ({
	header,
	status,
	icon,
	compact,
	statusLabel,
	tasklet,
	receipt,
	renderWidth,
}) => {
	const statusColor = getStatusColor(status)
	const categoryColor = getIconCategoryColor(icon)
	const statusIcon = getStatusIcon(status)
	const isRunning = status === CardStatus.RUNNING || status === CardStatus.BUILDING
	const headerPresentation = getHeaderPresentation(status)
	const displayStatus = statusLabel ?? status.toLowerCase().replaceAll("_", " ")
	const headerColor = headerPresentation.color
	const headerBold = "bold" in headerPresentation ? headerPresentation.bold : false
	if (receipt) {
		const outcome = TASKLET_RECEIPT_OUTCOMES[receipt.outcome]
		const receiptIcon = getIcon(TASKLET_RECEIPT_OPERATIONS[receipt.operation].icon)
		const titleWidth =
			(renderWidth ?? process.stdout.columns ?? 80) - stringWidth(receiptIcon) - stringWidth(outcome.label) - 4
		if (titleWidth < 2)
			return (
				<Text color={taskletReceiptColor(outcome.tone)} wrap="truncate-end">
					[{outcome.label}]
				</Text>
			)
		let title = taskletReceiptTitle(receipt).replace(/\s+/g, " ").trim()
		if (stringWidth(title) > titleWidth) {
			let clipped = ""
			for (const character of title) {
				if (stringWidth(`${clipped}${character}…`) > titleWidth) break
				clipped += character
			}
			title = `${clipped}…`
		}
		return (
			<Text wrap="truncate-end">
				<Text color={categoryColor}>{receiptIcon}</Text>{" "}
				<Text bold={headerBold} color={headerColor}>
					{title}
				</Text>{" "}
				<Text color={taskletReceiptColor(outcome.tone)}>[{outcome.label}]</Text>
			</Text>
		)
	}

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
