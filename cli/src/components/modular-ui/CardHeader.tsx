import { CardStatus } from "@shared/ExtensionMessage"
import { Text } from "ink"
import Spinner from "ink-spinner"
import React from "react"
import { getIcon, getIconCategoryColor, getStatusColor, getStatusIcon } from "../../utils/icon-mapping"

interface CardHeaderProps {
	header: string
	status: CardStatus
	icon?: string
	isCollapsed?: boolean
	compact?: boolean
}

export const CardHeader: React.FC<CardHeaderProps> = ({ header, status, icon, compact }) => {
	const color = getStatusColor(status)
	const statusIcon = getStatusIcon(status)
	const isRunning = status === "running" || status === "building"

	if (compact) {
		return (
			<Text bold>
				<Text color={getIconCategoryColor(icon)}>{getIcon(icon)}</Text> {header}{" "}
				<Text color={color}>{isRunning ? <Spinner type="dots" /> : statusIcon}</Text>
			</Text>
		)
	}

	return (
		<Text bold>
			<Text color={color}>{isRunning ? <Spinner type="dots" /> : statusIcon}</Text>{" "}
			<Text color={getIconCategoryColor(icon)}>{getIcon(icon)}</Text> {header}{" "}
			<Text color={color} dimColor>
				{status.toUpperCase()}
			</Text>
		</Text>
	)
}
