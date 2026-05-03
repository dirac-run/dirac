/**
 * User input prompt component
 * Handles different types of user interactions (text input, confirmations, choices)
 */

import type { DiracAsk, DiracMessage } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import React from "react"
import { useLastCompletedAskMessage } from "../hooks/useStateSubscriber"

import { jsonParseSafe } from "../utils/parser"

type PromptType = "confirmation" | "text" | "options" | "plan_mode_text" | "completion" | "exit_confirmation" | "none"

function getPromptType(ask: DiracAsk, text: string): PromptType {
	switch (ask) {
		case "followup": {
			const parts = jsonParseSafe(text, {
				question: undefined as string | undefined,
				options: undefined as string[] | undefined,
			})
			if (parts.options && parts.options.length > 0) {
				return "options"
			}
			return "text"
		}
		case "plan_mode_respond": {
			const parts = jsonParseSafe(text, {
				question: undefined as string | undefined,
				options: undefined as string[] | undefined,
			})
			if (parts.options && parts.options.length > 0) {
				return "options"
			}
			// Plan mode without options - allow text input or toggle to Act mode
			return "plan_mode_text"
		}
		case "completion_result":
			// Task completed - allow follow-up question or exit
			return "completion"

		case "resume_task":
		case "resume_completed_task":
			return "exit_confirmation"

		case "command":
		case "tool":
		case "browser_action_launch":
			return "confirmation"
		default:
			return "none"
	}
}

export const AskPrompt: React.FC = () => {
	const lastAskMessage = useLastCompletedAskMessage()
	
	if (!lastAskMessage) {
		return null
	}

	const ask = lastAskMessage.ask as DiracAsk
	const text = lastAskMessage.text || ""
	const promptType = getPromptType(ask, text)
	const icon = getCliMessagePrefixIcon(lastAskMessage)

	if (promptType === "none") {
		return null
	}

	switch (ask) {
		case "followup": {
			const parts = jsonParseSafe(text, {
				question: undefined as string | undefined,
				options: undefined as string[] | undefined,
			})

			if (parts.options && parts.options.length > 0) {
				return (
					<Box flexDirection="column" marginTop={1}>
						<Text color="cyan">Select an option (enter number):</Text>
						{parts.options.map((opt, idx) => (
							<Box key={idx} marginLeft={2}>
								<Text>{`${idx + 1}. ${opt}`}</Text>
							</Box>
						))}
					</Box>
				)
			}

			// Text input prompt
			return (
				<Box flexDirection="column" marginTop={1}>
					<Box>
						<Text>{icon} </Text>
						<Text color="cyan">Reply: </Text>
					</Box>
				</Box>
			)
		}

		case "plan_mode_respond": {
			const parts = jsonParseSafe(text, {
				question: undefined as string | undefined,
				options: undefined as string[] | undefined,
			})

			if (parts.options && parts.options.length > 0) {
				return (
					<Box flexDirection="column" marginTop={1}>
						<Text color="cyan">Select an option (enter number):</Text>
						{parts.options.map((opt, idx) => (
							<Box key={idx} marginLeft={2}>
								<Text>{`${idx + 1}. ${opt}`}</Text>
							</Box>
						))}
					</Box>
				)
			}

			// Plan mode text input - show option to switch to Act mode
			return (
				<Box flexDirection="column" marginTop={1}>
					<Box>
						<Text>{icon} </Text>
						<Text color="cyan">Reply: </Text>
					</Box>
				</Box>
			)
		}

		case "command":
		case "tool": {


			const isCommand = ask === "command"
			const color = isCommand ? "yellow" : "blue"
			const label = isCommand ? "Execute this command?" : "Use this tool?"

			return (
				<Box flexDirection="column" marginTop={1}>
					<Box>
						<Text>{icon} </Text>
						<Text color={color}>{` ${label} `}</Text>
						<Text color="gray">
							[<Text bold color="white">y</Text>]es / [<Text bold color="white">n</Text>]o
							{!isCommand && (
								<React.Fragment>
									{" / ["}<Text bold color="white">c</Text>{"]omment / ["}<Text bold color="white">a</Text>{"]ll yes"}
								</React.Fragment>
							)}
						</Text>
					</Box>
				</Box>
			)
		}

		case "completion_result":
			return (
				<Box flexDirection="column" marginTop={1}>
					<Box>
						<Text>{icon} </Text>
						<Text color="cyan">Follow-up: </Text>
					</Box>
				</Box>
			)

		case "resume_task":
		case "resume_completed_task":
			return (
				<Box flexDirection="column" marginTop={1}>
					<Box>
						<Text>{icon} </Text>
						<Text color="cyan"> Resume task? </Text>
						<Text color="gray">(y/n)</Text>
					</Box>
				</Box>
			)

		case "browser_action_launch":
			return (
				<Box flexDirection="column" marginTop={1}>
					<Box>
						<Text>{icon} </Text>
						<Text color="cyan"> Launch browser? </Text>
						<Text color="gray">(y/n)</Text>
					</Box>
				</Box>
			)

		default:
			return null
	}
}

/**
 * Get emoji icon for message type
 */
function getCliMessagePrefixIcon(message: DiracMessage): string {
	if (message.type === "ask") {
		switch (message.ask) {
			case "followup":
				return "❓"
			case "command":
			case "command_output":
				return "⚙️"
			case "tool":
				return "🔧"
			case "completion_result":
				return "✅"
			case "api_req_failed":
				return "❌"
			case "resume_task":
			case "resume_completed_task":
				return "▶️"
			case "browser_action_launch":
				return "🌐"
			case "plan_mode_respond":
				return "📋"
			default:
				return "❔"
		}
	}
	switch (message.say) {
		case "task":
			return "📋"
		case "error":
			return "❌"
		case "text":
			return "💬"
		case "reasoning":
			return "🧠"
		case "completion_result":
			return "✅"
		case "user_feedback":
			return "👤"
		case "command":
		case "command_output":
			return "⚙️"
		case "tool":
			return "🔧"
		case "browser_action":
		case "browser_action_launch":
		case "browser_action_result":
			return "🌐"
		case "api_req_started":
		case "api_req_finished":
			return "🔄"
		case "checkpoint_created":
			return "💾"
		case "info":
			return "ℹ️"
		case "generate_explanation":
			return "📝"
		default:
			return "  "
	}
}
