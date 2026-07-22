import { memo } from "react"
import { MessageRenderer } from "./MessageRow"
import { ChatRowProps } from "../types/chatRowTypes"

const ChatRow = memo(
	(props: ChatRowProps) => {
		return (
			<div className="relative pt-1 px-3 group transition-colors duration-300 hover:bg-white/5">
				<MessageRenderer {...props} />
			</div>
		)
	},
	(prevProps, nextProps) => {
		return (
			prevProps.message === nextProps.message &&
			prevProps.isLast === nextProps.isLast &&
			prevProps.isExpanded === nextProps.isExpanded &&
			prevProps.isRequestInProgress === nextProps.isRequestInProgress &&
			prevProps.inputValue === nextProps.inputValue &&
			prevProps.mode === nextProps.mode &&
			prevProps.reasoningContent === nextProps.reasoningContent &&
			prevProps.responseStarted === nextProps.responseStarted &&
			prevProps.lastModifiedMessage === nextProps.lastModifiedMessage &&
			prevProps.activeCardId === nextProps.activeCardId &&
			prevProps.activeVoiceStreamId === nextProps.activeVoiceStreamId
		)
	},
)

export default ChatRow
