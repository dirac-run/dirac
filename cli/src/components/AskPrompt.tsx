import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import React from "react"
import { useLastCompletedAskMessage } from "../hooks/useStateSubscriber"
import { jsonParseSafe } from "../utils/parser"

type PromptType = "confirmation" | "text" | "options" | "plan_mode_text" | "completion" | "exit_confirmation" | "none"

function getPromptType(message: DiracMessage): PromptType {
	const { content } = message

	// If it's a modular card, the card itself handles the prompt
	if (content.type === "card") {
		return "none"
	}

	return "none"
}

export const AskPrompt: React.FC = () => {
	const lastAskMessage = useLastCompletedAskMessage()

	if (!lastAskMessage) {
		return null
	}

	const { content } = lastAskMessage
	if (content.type !== DiracMessageType.CARD) {
		return null
	}

	const { card } = content
	const icon = getCliMessagePrefixIcon(lastAskMessage)

	if (card.requireFeedback) {
		const parts = jsonParseSafe(card.body || "", {
			options: undefined as string[] | undefined,
		})

		if (parts.options && parts.options.length > 0) {
			return (
				<Box flexDirection="column" marginTop={1}>
					<Text color="cyan">Select an option (enter number):</Text>
					{parts.options.map((opt, idx) => (
						<Box key={idx} marginLeft={1}>
							<Text>{`${idx + 1}. ${opt}`}</Text>
						</Box>
					))}
				</Box>
			)
		}

		return (
			<Box flexDirection="column" marginTop={1}>
				<Box>
					<Text>{icon} </Text>
					<Text color="cyan">Reply: </Text>
				</Box>
			</Box>
		)
	}

	if (card.requireApproval) {
		const isCommand = card.header.toLowerCase().includes("command")
		const color = isCommand ? "yellow" : "blue"
		const label = isCommand ? "Execute this command?" : "Use this tool?"

		return (
			<Box flexDirection="column" marginTop={1}>
				<Box>
					<Text>{icon} </Text>
					<Text color={color}>{` ${label} `}</Text>
					<Text color="gray">
						[
						<Text bold color="white">
							y
						</Text>
						]es / [
						<Text bold color="white">
							n
						</Text>
						]o
					</Text>
				</Box>
			</Box>
		)
	}

	return null
}

function getCliMessagePrefixIcon(message: DiracMessage): string {
	const { content } = message

	if (content.type === DiracMessageType.API_STATUS) {
		return "🔄"
	}

	if (content.type === DiracMessageType.CARD) {
		const { card } = content
		if (card.status === "error") return "❌"
		if (card.status === "success") return "✅"
		if (card.header.toLowerCase().includes("command")) return "⚙️"
		if (card.header.toLowerCase().includes("tool")) return "🔧"
		if (card.header.toLowerCase().includes("browser")) return "🌐"
		if (card.requireFeedback) return "❓"
		return "ℹ️"
	}

	if (content.type === DiracMessageType.MARKDOWN) {
		if (content.isReasoning) return "🧠"
		return "💬"
	}

	return "  "
}
