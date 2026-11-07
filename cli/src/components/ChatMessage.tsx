/**
 * Claude Code style chat message component
 * Renders messages with:
 * - ❯ for user messages
 * - ⏺ for assistant messages and tool calls
 * - ⎿ for tool results (indented)
 */

import { isTaskCompletionCard } from "@shared/cardIdentity"
import { DiracMessage, DiracMessageType, SteeringTranscriptStatus } from "@shared/ExtensionMessage"
import { readTaskletPresentation } from "@shared/taskletPresentation"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import React from "react"
import { getModeColor } from "../constants/colors"
import { styles, theme } from "../constants/theme"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { cardDisplayBody } from "../utils/card-body"
import { clipTextToLastVisualLines, summarizeFirstLine } from "../utils/text-clipping"
import { Markdown } from "./modular-ui/Markdown"
import { ModularCard } from "./modular-ui/ModularCard"
import { TaskCompletionCard } from "./modular-ui/TaskCompletionCard"

/**
 * Add "(Tab)" hint after "Act mode" mentions in plain text.
 * Case-insensitive, avoids double-adding if already present.
 */

interface ChatMessageProps {
	message: DiracMessage
	isStreaming?: boolean
	isExecuting?: boolean
	mode?: "act" | "plan"
	activeVoiceStreamId?: string
	showReasoning?: boolean
	reasoningDisplay?: "tail" | "full"
	compact?: boolean
	tailOnly?: boolean
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

const ReasoningMessage: React.FC<{
	content: string
	isStreaming: boolean
	showReasoning: boolean
	display: "tail" | "full"
	compact?: boolean
	mode?: "act" | "plan"
	columns: number
}> = ({ content, isStreaming, showReasoning, display, compact = false, mode = "act", columns }) => {
	if (!showReasoning) {
		return null
	}

	const reasoningAccent = isStreaming ? getModeColor(mode) : styles.conversation.reasoningTitle.color
	const reasoningColor = styles.conversation.reasoning.color
	if (!content.trim()) {
		return null
	}

	if (compact) {
		return (
			<Text>
				<Text color={theme.muted}>⎿ </Text>
				<Text color={reasoningAccent}>Thinking</Text>
				<Text color={theme.muted}>{summarizeFirstLine(content) ? ` · ${summarizeFirstLine(content)}` : ""}</Text>
			</Text>
		)
	}

	return (
		<React.Fragment>
			<DotRow color={reasoningAccent} prefix="◇">
				<Box flexDirection="column">
					<Text color={reasoningAccent}>Thinking</Text>
					<Markdown
						color={reasoningColor}
						maxLines={display === "tail" ? REASONING_VISIBLE_LINES : undefined}
						padLines
						width={Math.max(1, columns - 4)}>
						{content}
					</Markdown>
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
	showReasoning = true,
	reasoningDisplay = "tail",
	compact = false,
	tailOnly = false,
	maxContentLines,
	scrollOffset,
	suppressCardBody,
	mode,
}) => {
	const { columns } = useTerminalSize()
	const isStreaming = isStreamingProp || message.id === activeVoiceStreamId
	if (tailOnly && maxContentLines) {
		return renderTimelineTail(message, maxContentLines, columns, suppressCardBody)
	}
	if (maxContentLines && message.content.type === DiracMessageType.MARKDOWN && !message.content.isReasoning) {
		return renderBoundedMarkdownMessage(message.content, maxContentLines, columns, scrollOffset ?? 0)
	}
	// --- New Protocol Dispatcher ---
	if ("content" in message) {
		switch (message.content.type) {
			case DiracMessageType.MARKDOWN:
				if (message.content.isReasoning) {
					return (
						<ReasoningMessage
							columns={columns}
							compact={compact}
							content={message.content.content}
							display={reasoningDisplay}
							isStreaming={isStreaming}
							mode={mode}
							showReasoning={showReasoning}
						/>
					)
				}
				const markdownRole = message.content.role === "user" ? "user" : "assistant"
				const roleColor = markdownRole === "user" ? styles.conversation.user.color : styles.conversation.assistant.color
				const contentColor = roleColor

				if (compact) {
					return (
						<Text>
							<Text color={theme.muted}>⎿ </Text>
							<Text color={roleColor}>{markdownRole === "user" ? "User" : "Assistant"}</Text>
							<Text color={theme.muted} dimColor>
								{summarizeFirstLine(message.content.content)
									? ` · ${summarizeFirstLine(message.content.content)}`
									: ""}
							</Text>
						</Text>
					)
				}
				return (
					<React.Fragment>
						<DotRow color={roleColor} prefix={markdownRole === "user" ? "❯" : undefined}>
							<Markdown color={contentColor} width={Math.max(1, columns - 4)}>
								{message.content.content}
							</Markdown>
						</DotRow>
						{message.content.steering && (
							<DotRow color={theme.muted} prefix=" ">
								<Text color={theme.muted} dimColor>
									{message.content.steering.status === SteeringTranscriptStatus.QUEUED
										? "Queued for next turn"
										: "Sent with next turn"}
								</Text>
							</DotRow>
						)}
						<Text>{"\n"}</Text>
					</React.Fragment>
				)
			case DiracMessageType.CARD:
				if (!readTaskletPresentation(message.content.card) && isTaskCompletionCard(message.content.card)) {
					return (
						<TaskCompletionCard
							card={message.content.card}
							maxBodyLines={maxContentLines}
							scrollOffset={scrollOffset}
							suppressBody={suppressCardBody}
						/>
					)
				}
				return (
					<ModularCard
						card={message.content.card}
						maxBodyLines={maxContentLines}
						scrollOffset={scrollOffset}
						suppressBody={suppressCardBody}
					/>
				)
			case DiracMessageType.API_STATUS:
				// API status is summarized in the status bar in CLI
				return null
			default:
				return (
					<Box borderColor={theme.error} borderStyle="single" paddingX={1}>
						<Text color={theme.error}>Protocol Error: Unknown primitive type "{(message.content as any).type}"</Text>
					</Box>
				)
		}
	}

	// If we reach here, it means the message doesn't have the 'content' field,
	// which should be impossible according to the new DiracMessage type.
	return (
		<Box borderColor={theme.error} borderStyle="single" paddingX={1}>
			<Text color={theme.error}>Protocol Error: Message is missing "content" field.</Text>
		</Box>
	)
}
function renderBoundedMarkdownMessage(
	content: Extract<DiracMessage["content"], { type: DiracMessageType.MARKDOWN }>,
	maxLines: number,
	columns: number,
	scrollOffset: number,
): React.ReactNode {
	const role = content.role === "user" ? "user" : "assistant"
	const color = role === "user" ? styles.conversation.user.color : styles.conversation.assistant.color
	return (
		<DotRow color={color} prefix={role === "user" ? "❯" : undefined}>
			<Markdown color={color} maxLines={maxLines} scrollOffset={scrollOffset} width={Math.max(1, columns - 4)}>
				{content.content}
			</Markdown>
		</DotRow>
	)
}

function renderTimelineTail(message: DiracMessage, maxLines: number, columns: number, suppressCardBody = false): React.ReactNode {
	const width = Math.max(1, columns - 4)
	if (message.content.type === DiracMessageType.MARKDOWN) {
		const color = message.content.isReasoning
			? styles.conversation.reasoning.color
			: message.content.role === "user"
				? styles.conversation.user.color
				: styles.conversation.assistant.color
		return (
			<Markdown color={color} maxLines={maxLines} width={width}>
				{message.content.content}
			</Markdown>
		)
	}

	if (message.content.type === DiracMessageType.CARD) {
		if (message.content.card.taskletReceipt || readTaskletPresentation(message.content.card)) {
			return (
				<ModularCard
					card={message.content.card}
					maxBodyLines={Math.max(1, maxLines - 2)}
					suppressBody={suppressCardBody || maxLines <= 2}
				/>
			)
		}
		if (suppressCardBody) return <ModularCard card={message.content.card} suppressBody />
		const body = cardDisplayBody(message.content.card)
		if (body) {
			if (message.content.card.renderType === "markdown") {
				return (
					<Markdown color={styles.tool.body.color} maxLines={maxLines} width={Math.max(1, columns - 6)}>
						{body}
					</Markdown>
				)
			}
			return <Text {...styles.tool.body}>{clipTextToLastVisualLines(body, maxLines, width, "")}</Text>
		}
		return <ModularCard card={message.content.card} suppressBody />
	}

	return null
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
							<Text {...styles.conversation.typeChangeSep}>
								{"─".repeat(Math.max(1, Math.min(40, columns - 4)))}
							</Text>
						</Box>
					)}
					{idx > 0 &&
						messagesToShow[idx - 1].content.type === msg.content.type &&
						msg.content.type === DiracMessageType.MARKDOWN && (
							<Box key={`sep-md-${idx}`}>
								<Text {...styles.conversation.divider} wrap="truncate-end">
									{"── · ── · ──".repeat(3)}
								</Text>
							</Box>
						)}
					<ChatMessage
						activeVoiceStreamId={activeVoiceStreamId}
						isStreaming={idx === messagesToShow.length - 1 && isLastStreaming}
						message={msg}
						mode={mode}
						showReasoning={showReasoning}
					/>
				</React.Fragment>
			))}
		</React.Fragment>
	)
}
