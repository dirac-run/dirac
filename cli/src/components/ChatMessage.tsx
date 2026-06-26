/**
 * Claude Code style chat message component
 * Renders messages with:
 * - ❯ for user messages
 * - ⏺ for assistant messages and tool calls
 * - ⎿ for tool results (indented)
 */

import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import React from "react"
import { Markdown } from "./modular-ui/Markdown"
import { styles } from "../constants/theme"
import { getModeColor } from "../constants/colors"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { ModularCard } from "./modular-ui/ModularCard"
import { clipTextToLastVisualLines, estimateVisualLineCount, summarizeFirstLine } from "../utils/text-clipping"

/**
 * Add "(Tab)" hint after "Act mode" mentions in plain text.
 * Case-insensitive, avoids double-adding if already present.
 */

interface ChatMessageProps {
	message: DiracMessage
	isStreaming?: boolean
	isExecuting?: boolean
	mode?: "act" | "plan"
	isExpanded?: boolean
	onCollapse?: () => void
	activeVoiceStreamId?: string
	showReasoning?: boolean
	compact?: boolean
	maxContentLines?: number
	scrollOffset?: number
	suppressCardBody?: boolean
}

/**
 * Two-column layout for messages with a dot prefix.
 * Keeps content from wrapping under the dot.
 *
 * For this to work properly, parent containers must have width="100%"
 * so flexGrow={1} on the content box has a reference width to fill.
 */
const DotRow: React.FC<{ children: React.ReactNode; color?: string; flashing?: boolean; prefix?: string }> = ({
	children,
	color,
	flashing = false,
	prefix = "⏺",
}) => (
	<Box flexDirection="row">
		<Box width={2}>
			{flashing ? (
				<Text color={color}>
					<Spinner type="toggle8" />
				</Text>
			) : (
				<Text color={color}>{prefix}</Text>
			)}
		</Box>
		<Box flexGrow={1}>{children}</Box>
	</Box>
)

const REASONING_VISIBLE_LINES = 3

function clipReasoningText(content: string, columns: number): string {
	const visibleText = clipTextToLastVisualLines(content, REASONING_VISIBLE_LINES, columns, "").replace(/^\n/, "")
	return padTextToVisualLines(visibleText, REASONING_VISIBLE_LINES, columns)
}

function padTextToVisualLines(text: string, targetLines: number, columns: number): string {
	const missingLines = targetLines - estimateVisualLineCount(text, columns)
	if (missingLines <= 0) return text
	return `${text}${"\n".repeat(missingLines)}`
}

const ReasoningMessage: React.FC<{
	content: string
	isStreaming: boolean
	showReasoning: boolean
	compact?: boolean
	mode?: "act" | "plan"
	columns: number
}> = ({ content, isStreaming, showReasoning, compact = false, mode = "act", columns }) => {
	if (!showReasoning) {
		return null
	}

	const reasoningColor = isStreaming ? getModeColor(mode) : styles.conversation.reasoning.color
	const visibleContent = clipReasoningText(content, Math.max(1, columns - 4))

	if (!visibleContent.trim()) {
		return null
	}

	if (compact) {
		return (
			<Text>
				<Text color="gray">⎿ </Text>
				<Text color={reasoningColor}>Thinking</Text>
				<Text color={reasoningColor} dimColor={!isStreaming}>
					{summarizeFirstLine(content) ? ` · ${summarizeFirstLine(content)}` : ""}
				</Text>
			</Text>
		)
	}

	return (
		<React.Fragment>
			<DotRow color={reasoningColor} prefix="◇">
				<Box flexDirection="column">
					<Text color={reasoningColor} dimColor={!isStreaming}>
						Thinking
					</Text>
					<Text color={reasoningColor}>{visibleContent}</Text>
				</Box>
			</DotRow>
			<Text>{"\n"}</Text>
		</React.Fragment>
	)
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
	message,
	isStreaming: isStreamingProp,
	activeVoiceStreamId,
	isExpanded,
	showReasoning = true,
	compact = false,
	maxContentLines,
	scrollOffset,
	suppressCardBody,
	onCollapse,
	mode,
}) => {
	const { columns } = useTerminalSize()
	const isStreaming = isStreamingProp || message.id === activeVoiceStreamId
	// --- New Protocol Dispatcher ---
	if ("content" in message) {
		switch (message.content.type) {
			case "markdown":
				if (message.content.isReasoning) {
					return (
						<ReasoningMessage
							columns={columns}
							compact={compact}
							content={message.content.content}
							mode={mode}
							isStreaming={isStreaming}
							showReasoning={showReasoning}
						/>
					)
				}
				const markdownRole = message.content.role === "user" ? "user" : "assistant"
				const roleColor = markdownRole === "user" ? styles.conversation.user.color : styles.conversation.assistant.color
				const contentColor =
					markdownRole === "assistant" && mode === "plan" ? styles.conversation.planModeTint.color : roleColor

				if (compact) {
					return (
						<Text>
							<Text color="gray">⎿ </Text>
							<Text color={roleColor}>{markdownRole === "user" ? "User" : "Assistant"}</Text>
							<Text color="gray" dimColor>
								{summarizeFirstLine(message.content.content)
									? ` · ${summarizeFirstLine(message.content.content)}`
									: ""}
							</Text>
						</Text>
					)
				}
				const markdownContent = maxContentLines
					? clipTextToLastVisualLines(message.content.content, maxContentLines, Math.max(1, columns - 4))
					: message.content.content
				return (
					<React.Fragment>
						<DotRow color={roleColor} prefix={markdownRole === "user" ? "❯" : undefined}>
							<Markdown color={contentColor}>{markdownContent}</Markdown>
						</DotRow>
						<Text>{"\n"}</Text>
					</React.Fragment>
				)
			case "card":
				return (
					<ModularCard
						card={message.content.card}
						isCompact={compact}
						isExpanded={isExpanded}
						isStreaming={isStreaming}
						maxBodyLines={maxContentLines}
						onCollapse={onCollapse}
						scrollOffset={scrollOffset}
						suppressBody={suppressCardBody}
					/>
				)
			case "api_status":
				// API status is summarized in the status bar in CLI
				return null
			default:
				return (
					<Box borderStyle="single" borderColor="red" paddingX={1}>
						<Text color="red">Protocol Error: Unknown primitive type "{(message.content as any).type}"</Text>
					</Box>
				)
		}
	}

	// If we reach here, it means the message doesn't have the 'content' field,
	// which should be impossible according to the new DiracMessage type.
	return (
		<Box borderStyle="single" borderColor="red" paddingX={1}>
			<Text color="red">Protocol Error: Message is missing "content" field.</Text>
		</Box>
	)
}

/**
 * Information
 * Render a list of messages in Claude Code style
 */
interface ChatMessageListProps {
	messages: DiracMessage[]
	maxMessages?: number
	activeVoiceStreamId?: string
	mode?: "act" | "plan"
	showReasoning?: boolean
}

export const ChatMessageList: React.FC<ChatMessageListProps> = ({
	messages,
	maxMessages,
	activeVoiceStreamId,
	mode,
	showReasoning = true,
}) => {
	// Filter out messages we don't want to display
	const displayMessages = messages.filter((m) => {
		// Skip api_status if it's just a marker (though in CLI we usually skip it anyway)
		if (m.content.type === DiracMessageType.API_STATUS) return false
		return true
	})

	const { columns } = useTerminalSize()
	// Optionally limit number of messages shown
	const messagesToShow = maxMessages ? displayMessages.slice(-maxMessages) : displayMessages

	// Check if last message is streaming
	const lastMessage = messagesToShow[messagesToShow.length - 1]
	const isLastStreaming = lastMessage && lastMessage.id === activeVoiceStreamId

	return (
		<React.Fragment>
			{messagesToShow.map((msg, idx) => (
				<React.Fragment key={msg.id || msg.ts}>
					{idx > 0 && messagesToShow[idx - 1].content.type !== msg.content.type && (
						<Box key={`sep-${idx}`}>
							<Text {...styles.conversation.typeChangeSep}>{"─".repeat(Math.min(40, columns - 4))}</Text>
						</Box>
					)}
					{idx > 0 &&
						messagesToShow[idx - 1].content.type === msg.content.type &&
						msg.content.type === DiracMessageType.MARKDOWN && (
							<Box key={`sep-md-${idx}`}>
								<Text {...styles.conversation.divider}>{"── · ── · ──".repeat(3)}</Text>
							</Box>
						)}
					<ChatMessage
						isStreaming={idx === messagesToShow.length - 1 && isLastStreaming}
						activeVoiceStreamId={activeVoiceStreamId}
						message={msg}
						mode={mode}
						showReasoning={showReasoning}
					/>
				</React.Fragment>
			))}
		</React.Fragment>
	)
}
