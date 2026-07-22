import type { DiracMessage } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { memo } from "react"
import { cn } from "@/lib/utils"
import type { MessageHandlers } from "../types/chatTypes"
import ChatRow from "./ChatRow"

interface MessageRendererProps {
	index: number
	message: DiracMessage
	renderedMessages: DiracMessage[]
	expandedRows: Record<string, boolean>
	onToggleExpand: (id: string) => void
	onSetQuote: (quote: string | null) => void
	messageHandlers: MessageHandlers
	footerActive: boolean
	activeCardId?: string
	activeVoiceStreamId?: string
}

/** Renders one virtualized protocol message. */
export const MessageRenderer = memo(
	({
		index,
		message,
		renderedMessages,
		expandedRows,
		onToggleExpand,
		onSetQuote,
		messageHandlers,
		footerActive,
		activeCardId,
		activeVoiceStreamId,
	}: MessageRendererProps) => {
		const isLastMessage = index === renderedMessages.length - 1

		return (
			<div
				className={cn({
					"pb-1.5": isLastMessage && !footerActive,
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
