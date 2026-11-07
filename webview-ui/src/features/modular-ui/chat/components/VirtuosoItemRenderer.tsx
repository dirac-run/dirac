import { DiracAskResponse } from "@shared/WebviewMessage"
import { memo } from "react"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/features/chat/store/chatStore"
import type { MessageHandlers } from "../types/chatTypes"
import ChatRow from "./ChatRow"

interface MessageRendererProps {
	messageId: string
	isLastMessage: boolean
	expandedRows: Record<string, boolean>
	onToggleExpand: (id: string) => void
	onSetQuote: (quote: string | null) => void
	messageHandlers: MessageHandlers
	activeCardId?: string
	activeVoiceStreamId?: string
}

/** Renders one virtualized protocol message. */
export const MessageRenderer = memo(
	({
		messageId,
		isLastMessage,
		expandedRows,
		onToggleExpand,
		onSetQuote,
		messageHandlers,
		activeCardId,
		activeVoiceStreamId,
	}: MessageRendererProps) => {
		const message = useChatStore((state) => {
			const index = state.messageIndexById.get(messageId)
			return index === undefined ? undefined : state.diracMessages[index]
		})
		const localMessage = useChatStore((state) => state.localObservationMessages.get(messageId))
		if (localMessage) {
			return (
				<section
					aria-label="Local agent snapshot"
					className="my-2 rounded-md border border-foreground/10 px-3 py-2 text-sm text-description"
					data-message-id={localMessage.id}>
					<div className="mb-1 text-xs opacity-70">Local · /agents · not sent to the model</div>
					<div className="whitespace-pre-wrap break-words">{localMessage.text}</div>
				</section>
			)
		}
		if (!message) return null
		return (
			<div
				className={cn({
					"pb-1.5": isLastMessage,
				})}
				data-message-id={message.id}>
				<ChatRow
					activeCardId={activeCardId}
					activeVoiceStreamId={activeVoiceStreamId}
					isExpanded={expandedRows[message.id] || false}
					key={message.id}
					message={message}
					onAction={(value, cardId) =>
						messageHandlers.executeButtonAction("utility", value, undefined, undefined, undefined, cardId)
					}
					onApprove={() =>
						messageHandlers.executeButtonAction(
							DiracAskResponse.APPROVE,
							undefined,
							undefined,
							undefined,
							undefined,
							message.id,
						)
					}
					onCancelCommand={() => messageHandlers.executeButtonAction("cancel")}
					onReject={() =>
						messageHandlers.executeButtonAction(
							DiracAskResponse.REJECT,
							undefined,
							undefined,
							undefined,
							undefined,
							message.id,
						)
					}
					onSetQuote={onSetQuote}
					onToggleExpand={onToggleExpand}
					sendMessageFromChatRow={messageHandlers.handleSendMessage}
				/>
			</div>
		)
	},
)

MessageRenderer.displayName = "MessageRenderer"
