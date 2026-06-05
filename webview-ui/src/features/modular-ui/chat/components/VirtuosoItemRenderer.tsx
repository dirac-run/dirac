import type { DiracMessage, Mode } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { memo, useMemo } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import ChatRow from "./ChatRow"
import type { MessageHandlers } from "../types/chatTypes"

interface MessageRendererProps {
    index: number
    messageOrGroup: DiracMessage | DiracMessage[]
    groupedMessages: (DiracMessage | DiracMessage[])[]
    modifiedMessages: DiracMessage[]
    expandedRows: Record<number, boolean>
    onToggleExpand: (ts: number) => void
    onSetQuote: (quote: string | null) => void
    inputValue: string
    messageHandlers: MessageHandlers
    footerActive: boolean
    activeCardId?: string
    activeVoiceStreamId?: string

}

/**
 * Specialized component for rendering different message types
 * Handles browser sessions, regular messages, and checkpoint logic
 */
export const MessageRenderer = memo(
    ({
        index,
        messageOrGroup,
        groupedMessages,
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

        const isLastMessage = useMemo(() => index === groupedMessages?.length - 1, [groupedMessages, index])

        if (Array.isArray(messageOrGroup)) {
            // In the new protocol, we don't group messages in the UI anymore.
            // If we still have groups, it's from legacy code or unexpected state.
            return (
                <div className="p-2 border border-error bg-error/10 text-error rounded-md m-2">
                    <strong>Protocol Error:</strong> Unexpected grouped messages.
                </div>
            )
        }

        return (
            <div
                className={cn({
                    "pb-1.5": isLastMessage && !footerActive,
                })}
                data-message-ts={messageOrGroup.ts}>
                <ChatRow
                    inputValue={inputValue}
                    isExpanded={expandedRows[messageOrGroup.ts] || false}
                    isLast={isLastMessage}
                    isRequestInProgress={false} // Handled by the new protocol partial flag
                    key={messageOrGroup.id || messageOrGroup.ts}
                    lastModifiedMessage={modifiedMessages.at(-1)}
                    message={messageOrGroup}
                    mode={mode}
                    onCancelCommand={() => messageHandlers.executeButtonAction("cancel")}
                    onSetQuote={onSetQuote}
                    onToggleExpand={onToggleExpand}
                    sendMessageFromChatRow={messageHandlers.handleSendMessage}
                    onApprove={() => messageHandlers.executeButtonAction(DiracAskResponse.APPROVE, undefined, undefined, undefined, undefined, messageOrGroup.id)}
                    onReject={() => messageHandlers.executeButtonAction(DiracAskResponse.REJECT, undefined, undefined, undefined, undefined, messageOrGroup.id)}
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
    groupedMessages: (DiracMessage | DiracMessage[])[],
    modifiedMessages: DiracMessage[],
    expandedRows: Record<number, boolean>,
    onToggleExpand: (ts: number) => void,
    onSetQuote: (quote: string | null) => void,
    inputValue: string,
    messageHandlers: MessageHandlers,
    footerActive: boolean,
    activeCardId?: string,
    activeVoiceStreamId?: string,

) => {
    return (index: number, messageOrGroup: DiracMessage | DiracMessage[]) => (
        <MessageRenderer
            expandedRows={expandedRows}
            footerActive={footerActive}
            groupedMessages={groupedMessages}
            index={index}
            inputValue={inputValue}
            messageHandlers={messageHandlers}
            messageOrGroup={messageOrGroup}
            modifiedMessages={modifiedMessages}
            onSetQuote={onSetQuote}
            onToggleExpand={onToggleExpand}
            activeCardId={activeCardId}
            activeVoiceStreamId={activeVoiceStreamId}

        />
    )
}
