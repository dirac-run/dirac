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
import { useTerminalSize } from "../hooks/useTerminalSize"
import { ModularCard } from "./modular-ui/ModularCard"


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



export const ChatMessage: React.FC<ChatMessageProps> = ({
    message,
    isStreaming: isStreamingProp,
    activeVoiceStreamId,
    isExpanded,
    onCollapse,
    mode,
}) => {
    const isStreaming = isStreamingProp || (message.id === activeVoiceStreamId)
    // --- New Protocol Dispatcher ---
    if ("content" in message) {
        switch (message.content.type) {
            case "markdown":
                if (message.content.isReasoning) {
                    // Reasoning is hidden in CLI by default to avoid clutter
                    return null
                }
                return (
                    <Box flexDirection="column" marginBottom={1} width="100%">
                        <DotRow color={message.content.role === "user" ? "green" : undefined} prefix={message.content.role === "user" ? "❯" : undefined}>
                            <Markdown color={mode === "plan" ? styles.conversation.planModeTint.color : undefined}>{message.content.content}</Markdown>
                        </DotRow>
                    </Box>
                )
            case "card":
                return <ModularCard card={message.content.card} isStreaming={isStreaming} isExpanded={isExpanded} onCollapse={onCollapse} />
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
}

export const ChatMessageList: React.FC<ChatMessageListProps> = ({ messages, maxMessages, activeVoiceStreamId, mode }) => {
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
        <Box flexDirection="column">
            {messagesToShow.map((msg, idx) => (
                <React.Fragment key={msg.id || msg.ts}>
                    {idx > 0 && messagesToShow[idx - 1].content.type !== msg.content.type && (
                        <Box key={`sep-${idx}`}>
                            <Text {...styles.conversation.typeChangeSep}>{"─".repeat(Math.min(40, columns - 4))}</Text>
                        </Box>
                    )}
                    {idx > 0 && messagesToShow[idx - 1].content.type === msg.content.type && msg.content.type === DiracMessageType.MARKDOWN && (
                        <Box key={`sep-md-${idx}`}>
                            <Text {...styles.conversation.divider}>{"── · ── · ──".repeat(3)}</Text>
                        </Box>
                    )}
                    <ChatMessage
                        isStreaming={idx === messagesToShow.length - 1 && isLastStreaming}
                        activeVoiceStreamId={activeVoiceStreamId}
                        message={msg}
                        mode={mode}
                    />
                </React.Fragment>
            ))}
        </Box>
    )
}
