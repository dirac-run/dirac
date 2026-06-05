import { ActionButton } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import React from "react"

interface CardInteractionsProps {
	requireApproval?: boolean
	requireFeedback?: boolean
	feedbackPlaceholder?: string
	actions?: ActionButton[]
}

export const CardInteractions: React.FC<CardInteractionsProps> = ({
	requireApproval,
	requireFeedback,
	feedbackPlaceholder,
	actions,
}) => {
	if (!requireApproval && !requireFeedback && (!actions || actions.length === 0)) return null

	return (
		<Box flexDirection="column" marginLeft={1} marginTop={1}>
			{requireApproval && (
				<Box marginBottom={1}>
					<Text color="green" bold>Approve this action? </Text>
					<Text>
						[<Text bold color="green">y</Text>]es / [<Text bold color="red">n</Text>]o
					</Text>
				</Box>
			)}

			{requireFeedback && (
				<Box marginBottom={1}>
					<Text color="cyan" italic>
						{feedbackPlaceholder || "Waiting for feedback..."}
					</Text>
				</Box>
			)}

			{actions && actions.length > 0 && (
				<Box flexDirection="row" gap={1} flexWrap="wrap">
					{actions.map((action, idx) => (
						<Box key={idx}>
							<Text color="gray">[{idx + 1}] </Text>
							<Box backgroundColor={action.style === "danger" ? "red" : action.primary ? "cyan" : "green"} paddingX={1}>
								<Text color="white" bold>
									{action.label}
								</Text>
							</Box>
						</Box>
					))}
				</Box>
			)}
		</Box>
	)
}
