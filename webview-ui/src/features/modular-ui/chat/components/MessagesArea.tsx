import type { DiracMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useCallback, useMemo, useRef } from "react"
import { Virtuoso } from "react-virtuoso"
import { CHAT_CONSTANTS } from "../constants"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../types/chatTypes"
import { MessageRenderer } from "./VirtuosoItemRenderer"

interface MessagesAreaProps {
	task: DiracMessage
	renderedMessageIds: string[]
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
	renderedMessageIds,
	scrollBehavior,
	chatState,
	messageHandlers,
}) => {
	const {
		virtuosoRef,
		setScrollerEl,
		toggleRowExpansion,
		handleAtBottomStateChange,
		handleListHeightChanged,
		handleScrollKeyDown,
		handleScrollPointerDown,
		handleScrollPointerUp,
		handleScrollTouchEnd,
		handleScrollTouchMove,
		handleScrollTouchStart,
		handleScrollWheel,
		followOutput,
	} = scrollBehavior

	const { activeVoiceStreamId } = chatState
	const { expandedRows, setActiveQuote, uiActionState } = chatState
	const activeCardId = uiActionState?.activeCardId
	const messageHandlersRef = useRef(messageHandlers)
	messageHandlersRef.current = messageHandlers
	const stableMessageHandlers = useMemo<MessageHandlers>(
		() => ({
			executeButtonAction: (...args) => messageHandlersRef.current.executeButtonAction(...args),
			handleSendMessage: (...args) => messageHandlersRef.current.handleSendMessage(...args),
			handleTaskCloseButtonClick: () => messageHandlersRef.current.handleTaskCloseButtonClick(),
			startNewTask: () => messageHandlersRef.current.startNewTask(),
		}),
		[],
	)

	const itemContent = useCallback(
		(index: number, messageId: string) => (
			<MessageRenderer
				activeCardId={activeCardId}
				activeVoiceStreamId={activeVoiceStreamId}
				expandedRows={expandedRows}
				isLastMessage={index === renderedMessageIds.length - 1}
				messageHandlers={stableMessageHandlers}
				messageId={messageId}
				onSetQuote={setActiveQuote}
				onToggleExpand={toggleRowExpansion}
			/>
		),
		[
			activeCardId,
			activeVoiceStreamId,
			expandedRows,
			renderedMessageIds.length,
			setActiveQuote,
			stableMessageHandlers,
			toggleRowExpansion,
		],
	)

	return (
		<div className="modular-chat-transcript relative flex h-full min-h-0 flex-col overflow-hidden">
			<Virtuoso
				aria-label="Conversation messages"
				atBottomStateChange={handleAtBottomStateChange}
				atBottomThreshold={CHAT_CONSTANTS.AT_BOTTOM_THRESHOLD}
				className="grow custom-scrollbar focus:outline-none"
				computeItemKey={(_index, messageId) => messageId}
				data={renderedMessageIds}
				followOutput={followOutput}
				increaseViewportBy={{ top: 800, bottom: 200 }}
				initialTopMostItemIndex={{ index: "LAST", align: "end" }}
				itemContent={itemContent}
				key={task.id}
				onKeyDownCapture={handleScrollKeyDown}
				onPointerDownCapture={handleScrollPointerDown}
				onPointerUpCapture={handleScrollPointerUp}
				onTouchEndCapture={handleScrollTouchEnd}
				onTouchMoveCapture={handleScrollTouchMove}
				onTouchStartCapture={handleScrollTouchStart}
				onWheelCapture={handleScrollWheel}
				ref={virtuosoRef}
				scrollerRef={setScrollerEl}
				style={{
					height: "100%",
					overflowAnchor: "none",
					overscrollBehaviorY: "contain",
					scrollbarWidth: "thin",
					width: "100%",
				}}
				tabIndex={0}
				totalListHeightChanged={handleListHeightChanged}
			/>
		</div>
	)
}
