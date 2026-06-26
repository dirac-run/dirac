import { ActionButton } from "@shared/ExtensionMessage"
import { Text } from "ink"
import React from "react"

interface CardInteractionsProps {
	requireFeedback?: boolean
	feedbackPlaceholder?: string
	actions?: ActionButton[]
}

export const CardInteractions: React.FC<CardInteractionsProps> = ({ requireFeedback, feedbackPlaceholder, actions }) => {
	if (!requireFeedback && (!actions || actions.length === 0)) return null

	return (
		<React.Fragment>
			{requireFeedback && (
				<Text color="cyan" italic>
					{"   "}
					{feedbackPlaceholder || "Waiting for feedback..."}
					{"\n"}
				</Text>
			)}

			{actions && actions.length > 0 && (
				<Text>
					{"   "}
					{actions.map((action, idx) => (
						<Text key={idx}>
							<Text color="gray">[{idx + 1}] </Text>
							<Text color={action.style === "danger" ? "red" : action.primary ? "cyan" : "green"} bold>
								{action.label}
							</Text>
							{idx < actions.length - 1 ? "   " : ""}
						</Text>
					))}
					{"\n"}
				</Text>
			)}
		</React.Fragment>
	)
}
