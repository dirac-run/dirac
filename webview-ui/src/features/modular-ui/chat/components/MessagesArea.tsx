import type { DiracMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useCallback, useMemo, useRef } from "react"
import { Virtuoso } from "react-virtuoso"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../types/chatTypes"
import { MessageRenderer } from "./VirtuosoItemRenderer"

interface MessagesAreaProps {
    task: DiracMessage
    renderedMessages: DiracMessage[]
    modifiedMessages: DiracMessage[]
    scrollBehavior: ScrollBehavior
    chatState: ChatState
    messageHandlers: MessageHandlers
}

/**
 * The scrollable messages area with virtualized list
 * Handles rendering of chat rows
 */
export const MessagesArea: React.FC<MessagesAreaProps> = ({
    task,
    renderedMessages,
    modifiedMessages,
    scrollBehavior,
    chatState,
    messageHandlers,
}) => {
    const parentRef = useRef<HTMLDivElement>(null)

    const {
        virtuosoRef,
        toggleRowExpansion,
        setIsAtBottom,
        setShowScrollToBottom,
        disableAutoScrollRef,
        programmaticScrollRef,
        handleRangeChanged,
    } = scrollBehavior

    const { activeVoiceStreamId } = chatState
    const { expandedRows, inputValue, setActiveQuote, uiActionState } = chatState
    const activeCardId = uiActionState?.activeCardId

    // Use refs for renderer deps to keep itemContent callback stable
    const rendererStateRef = useRef({
        renderedMessages,
        modifiedMessages,
        expandedRows,
        toggleRowExpansion,
        setActiveQuote,
        inputValue,
        messageHandlers,
        activeCardId,
        activeVoiceStreamId,
    })
    rendererStateRef.current = {
        renderedMessages,
        modifiedMessages,
        expandedRows,
        toggleRowExpansion,
        setActiveQuote,
        inputValue,
        messageHandlers,
        activeCardId,
        activeVoiceStreamId,
    }

    const itemContent = useCallback(
        (index: number, message: DiracMessage) => {
            const state = rendererStateRef.current
            return (
                <MessageRenderer
                    index={index}
                    message={message}
                    renderedMessages={state.renderedMessages}
                    modifiedMessages={state.modifiedMessages}
                    expandedRows={state.expandedRows}
                    onToggleExpand={state.toggleRowExpansion}
                    onSetQuote={state.setActiveQuote}
                    inputValue={state.inputValue}
                    messageHandlers={state.messageHandlers}
                    footerActive={false}
                    activeCardId={state.activeCardId}
                    activeVoiceStreamId={state.activeVoiceStreamId}
                />
            )
        },
        [],
    )

    const virtuosoComponents = useMemo(
        () => ({
            Footer: () => <div className="min-h-1" />,
        }),
        [],
    )

    return (
        <div className="overflow-hidden flex flex-col h-full relative">
            <div className="grow flex">
                <div
                    className="scrollable grow overflow-y-scroll custom-scrollbar"
                    ref={parentRef}
                    style={{
                        height: "100%",
                        width: "100%",
                        overflowAnchor: "none",
                    }}>
                    <Virtuoso
                        atBottomStateChange={(isAtBottom) => {
                            if (programmaticScrollRef.current) {
                                programmaticScrollRef.current = false
                                return
                            }
                            setIsAtBottom(isAtBottom)
                            disableAutoScrollRef.current = !isAtBottom
                            setShowScrollToBottom(!isAtBottom)
                        }}
                        atBottomThreshold={80}
                        className="grow"
                        components={virtuosoComponents}
                        data={renderedMessages}
                        increaseViewportBy={{
                            top: 1_000,
                            bottom: 800,
                        }}
                        followOutput={(isAtBottom) => {
                            if (disableAutoScrollRef.current) return false
                            return "auto"
                        }}
                        initialTopMostItemIndex={renderedMessages.length - 1}
                        itemContent={itemContent}
                        key={task.id}
                        rangeChanged={handleRangeChanged}
                        ref={virtuosoRef}
                        scrollerRef={(ref) => {
                            if (ref instanceof HTMLElement) {
                                // @ts-expect-error
                                parentRef.current = ref
                            }
                        }}
                        style={{
                            scrollbarWidth: "none",
                            msOverflowStyle: "none",
                            overflowAnchor: "none",
                        }}
                    />
                </div>
            </div>
        </div>
    )
}
