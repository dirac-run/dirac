import { MessagesArea } from "../components/MessagesArea"
import { ChatSection, ChatViewContext } from "../types"

export const MessagesSection: ChatSection = {
	id: "messages",
	shouldRender: (context) => !!context.task || context.renderedMessageIds.length > 0,
	render: (context: ChatViewContext) => (
		<MessagesArea
			chatState={context.chatState}
			renderedMessageIds={context.renderedMessageIds}
			messageHandlers={context.messageHandlers}
			scrollBehavior={context.scrollBehavior}
			task={context.task}
		/>
	),
}
