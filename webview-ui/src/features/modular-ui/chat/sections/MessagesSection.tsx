import { MessagesArea } from "../components/MessagesArea"
import { ChatSection, ChatViewContext } from "../types"

export const MessagesSection: ChatSection = {
	id: "messages",
	shouldRender: (context) => !!context.task,
	render: (context: ChatViewContext) => (
		<MessagesArea
			chatState={context.chatState}
			groupedMessages={context.groupedMessages}
			messageHandlers={context.messageHandlers}
			modifiedMessages={context.modifiedMessages}
			scrollBehavior={context.scrollBehavior}
			task={context.task!}
		/>
	),
}
