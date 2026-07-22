import type { DiracMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useCallback, useMemo } from "react"
import { Virtuoso } from "react-virtuoso"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../types/chatTypes"
import { MessageRenderer } from "./VirtuosoItemRenderer"

interface MessagesAreaProps {
	task: DiracMessage
	renderedMessages: DiracMessage[]
	scrollBehavior: ScrollBehavior
	chatState: ChatState
	messageHandlers: MessageHandlers
}

/**
 * The scrollable messages area with virtualized list.
 * Message IDs are the row identity: card-local state must never follow a list index.
 */
export const MessagesArea: React.FC<MessagesAreaProps> = ({
	task,
	renderedMessages,
	scrollBehavior,
	chatState,
	messageHandlers,
}) => {
	const {
		virtuosoRef,
		footerRef,
		toggleRowExpansion,
		setIsAtBottom,
		setShowScrollToBottom,
		disableAutoScrollRef,
		programmaticScrollRef,
		handleRangeChanged,
	} = scrollBehavior

	const { activeVoiceStreamId } = chatState
	const { expandedRows, setActiveQuote, uiActionState } = chatState
	const activeCardId = uiActionState?.activeCardId

	const itemContent = useCallback(
		(index: number, message: DiracMessage) => (
			<MessageRenderer
				index={index}
				message={message}
				renderedMessages={renderedMessages}
				expandedRows={expandedRows}
				onToggleExpand={toggleRowExpansion}
				onSetQuote={setActiveQuote}
				messageHandlers={messageHandlers}
				footerActive={false}
				activeCardId={activeCardId}
				activeVoiceStreamId={activeVoiceStreamId}
			/>
		),
		[activeCardId, activeVoiceStreamId, expandedRows, messageHandlers, renderedMessages, setActiveQuote, toggleRowExpansion],
	)

	const virtuosoComponents = useMemo(
		() => ({
			Footer: () => <div ref={footerRef} className="min-h-1" />,
		}),
		[footerRef],
	)

	return (
		<div className="relative flex h-full min-h-0 flex-col overflow-hidden">
			<Virtuoso
				atBottomStateChange={(isAtBottom) => {
					if (programmaticScrollRef.current) {
						if (isAtBottom) {
							programmaticScrollRef.current = false
							setIsAtBottom(true)
							disableAutoScrollRef.current = false
							setShowScrollToBottom(false)
						}
						return
					}
					if (scrollBehavior.atBottomDebounceRef.current) {
						clearTimeout(scrollBehavior.atBottomDebounceRef.current)
					}
					scrollBehavior.atBottomDebounceRef.current = setTimeout(() => {
						setIsAtBottom(isAtBottom)
						disableAutoScrollRef.current = !isAtBottom
						setShowScrollToBottom(!isAtBottom)
					}, 80)
				}}
				atBottomThreshold={64}
				className="grow custom-scrollbar"
				components={virtuosoComponents}
				computeItemKey={(_index, message) => message.id}
				data={renderedMessages}
				increaseViewportBy={{ top: 1_000, bottom: 800 }}
				followOutput={() => (disableAutoScrollRef.current ? false : "auto")}
				initialTopMostItemIndex={Math.max(0, renderedMessages.length - 1)}
				itemContent={itemContent}
				key={task.id}
				rangeChanged={handleRangeChanged}
				ref={virtuosoRef}
				style={{
					height: "100%",
					width: "100%",
					scrollbarWidth: "thin",
					overflowAnchor: "none",
				}}
			/>
		</div>
	)
}
