import type { DiracMessage, Mode } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { memo, useMemo } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import ChatRow from "./ChatRow"
import type { MessageHandlers } from "../types/chatTypes"

interface MessageRendererProps {
    index: number
    message: DiracMessage
    renderedMessages: DiracMessage[]
    modifiedMessages: DiracMessage[]
    expandedRows: Record<string, boolean>
    onToggleExpand: (id: string) => void
    onSetQuote: (quote: string | null) => void
    inputValue: string
    messageHandlers: MessageHandlers
    footerActive: boolean
    activeCardId?: string
    activeVoiceStreamId?: string

}

/**
 * Specialized component for rendering different message types
 * Handles regular messages and checkpoint logic
 */
export const MessageRenderer = memo(
    ({
        index,
        message,
        renderedMessages,
        modifiedMessages,
        expandedRows,
        onToggleExpand,
        onSetQuote,
        inputValue,
        messageHandlers,
        footerActive,
        activeCardId,
        activeVoiceStreamId,

    }: MessageRendererProps) => {
        const { mode } = useSettingsStore() as { mode: Mode }

        const isLastMessage = useMemo(() => index === renderedMessages.length - 1, [renderedMessages, index])

        return (
            <div
                className={cn({
                    "pb-1.5": isLastMessage && !footerActive,
                })}
                data-message-id={message.id}>
                <ChatRow
                    inputValue={inputValue}
                    isExpanded={expandedRows[message.id] || false}
                    isLast={isLastMessage}
                    isRequestInProgress={false} // Handled by the new protocol partial flag
                    key={message.id}
                    lastModifiedMessage={modifiedMessages.at(-1)}
                    message={message}
                    mode={mode}
                    onCancelCommand={() => messageHandlers.executeButtonAction("cancel")}
                    onSetQuote={onSetQuote}
                    onToggleExpand={onToggleExpand}
                    sendMessageFromChatRow={messageHandlers.handleSendMessage}
                    onApprove={() => messageHandlers.executeButtonAction(DiracAskResponse.APPROVE, undefined, undefined, undefined, undefined, message.id)}
                    onReject={() => messageHandlers.executeButtonAction(DiracAskResponse.REJECT, undefined, undefined, undefined, undefined, message.id)}
                    onAction={(value, cardId) => messageHandlers.executeButtonAction("utility", value, undefined, undefined, undefined, cardId)}
                    activeCardId={activeCardId}
                    activeVoiceStreamId={activeVoiceStreamId}

                />
            </div>
        )
    }
)

/**
 * Factory function to create the itemContent callback for Virtuoso
 * This allows us to encapsulate the rendering logic while maintaining performance
 */
export const createMessageRenderer = (
    renderedMessages: DiracMessage[],
    modifiedMessages: DiracMessage[],
    expandedRows: Record<string, boolean>,
    onToggleExpand: (id: string) => void,
    onSetQuote: (quote: string | null) => void,
    inputValue: string,
    messageHandlers: MessageHandlers,
    footerActive: boolean,
    activeCardId?: string,
    activeVoiceStreamId?: string,

) => {
    return (index: number, message: DiracMessage) => (
        <MessageRenderer
            expandedRows={expandedRows}
            footerActive={footerActive}
            renderedMessages={renderedMessages}
            index={index}
            inputValue={inputValue}
            messageHandlers={messageHandlers}
            message={message}
            modifiedMessages={modifiedMessages}
            onSetQuote={onSetQuote}
            onToggleExpand={onToggleExpand}
            activeCardId={activeCardId}
            activeVoiceStreamId={activeVoiceStreamId}

        />
    )
}
