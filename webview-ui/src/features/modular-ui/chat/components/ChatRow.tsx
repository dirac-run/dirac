import { memo } from "react"
import { MessageRenderer } from "./MessageRow"
import { ChatRowProps } from "../types/chatRowTypes"

const ChatRow = memo(
	(props: ChatRowProps) => {
		return (
			<div className="group relative px-3 pt-1 transition-colors duration-150 hover:bg-foreground/[0.025]">
				<MessageRenderer {...props} />
			</div>
		)
	},
	(prevProps, nextProps) => {
		return (
			prevProps.message === nextProps.message &&
			prevProps.isExpanded === nextProps.isExpanded &&
			prevProps.activeCardId === nextProps.activeCardId &&
			prevProps.activeVoiceStreamId === nextProps.activeVoiceStreamId &&
			prevProps.onAction === nextProps.onAction &&
			prevProps.onApprove === nextProps.onApprove &&
			prevProps.onCancelCommand === nextProps.onCancelCommand &&
			prevProps.onReject === nextProps.onReject &&
			prevProps.onSetQuote === nextProps.onSetQuote &&
			prevProps.onToggleExpand === nextProps.onToggleExpand &&
			prevProps.sendMessageFromChatRow === nextProps.sendMessageFromChatRow
		)
	},
)

export default ChatRow
