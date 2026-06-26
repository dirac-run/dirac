/**
 * Action buttons component for CLI
 * Shows primary/secondary buttons above the input field
 * Supports keyboard navigation (1/2 for buttons, arrows to navigate, esc to cancel)
 */

import { type UIActionState } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { Box, Text } from "ink"
import React from "react"
import { COLORS } from "../constants/colors"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { getVisibleGlobalActionButtons } from "../utils/action-buttons"

/**
 * Button action types that determine the behavior
 */
export type ButtonActionType =
	| DiracAskResponse.APPROVE // Send approve response
	| DiracAskResponse.REJECT // Send reject response
	| "proceed" // Send approve response
	| "new_task" // Start a new task
	| "cancel" // Cancel streaming
	| "retry" // Retry the last action

/**
 * Button configuration for different message states
 */
export interface ButtonConfig {
	sendingDisabled: boolean
	enableButtons: boolean
	primaryText?: string
	secondaryText?: string
	primaryAction?: ButtonActionType
	secondaryAction?: ButtonActionType
}

/**
 * Centralized button state configurations based on task lifecycle
 */

const errorTypes = ["api_req_failed", "mistake_limit_reached"]

interface ActionButtonsProps {
	isProcessing?: boolean
	config: ButtonConfig
	mode?: "act" | "plan"
}

/**
 * Determine which buttons are actually visible based on config
 * Cancel is hidden in the CLI (ThinkingIndicator handles that with esc)
 */
export function getVisibleButtons(config: ButtonConfig) {
	const hiddenActions = ["cancel"]
	const hasPrimary = !!config.primaryText && !hiddenActions.includes(config.primaryAction || "")
	const hasSecondary = !!config.secondaryText && !hiddenActions.includes(config.secondaryAction || "")
	return { hasPrimary, hasSecondary }
}

export const ActionButtons: React.FC<{
	uiActionState: UIActionState
	mode?: "act" | "plan"
	isProcessing?: boolean
}> = ({ uiActionState, mode = "act", isProcessing }) => {
	const { columns: terminalWidth } = useTerminalSize()

	// Cancel is handled by ThinkingIndicator with Escape while work is active.
	const buttons = getVisibleGlobalActionButtons(uiActionState.globalButtons)

	if (buttons.length === 0) {
		return null
	}

	const buttonCount = buttons.length
	const gapWidth = buttonCount > 1 ? 1 : 0
	const availableWidth = terminalWidth - 2 - gapWidth
	const buttonWidth = Math.floor(availableWidth / buttonCount)

	const buttonColor = isProcessing ? "gray" : mode === "plan" ? "yellow" : COLORS.primaryBlue

	const renderButton = (text: string, shortcut: string, style?: string) => {
		const label = ` ${text} (${shortcut}) `
		const padding = Math.max(0, buttonWidth - label.length)
		const leftPad = Math.floor(padding / 2)
		const rightPad = padding - leftPad
		const paddedLabel = " ".repeat(leftPad) + label + " ".repeat(rightPad)

		const bgColor = style === "danger" ? "red" : style === "secondary" ? "gray" : buttonColor

		return (
			<Text backgroundColor={bgColor} color="black">
				{paddedLabel}
			</Text>
		)
	}

	return (
		<Box flexDirection="row" gap={1} marginLeft={1} width="100%" marginBottom={1}>
			{buttons.map((button, index) => renderButton(button.label, String(index + 1), button.style))}
		</Box>
	)
}
