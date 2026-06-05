import ActionButtons from "../../components/ActionButtons"
import { ChatViewDecorator, ChatViewContext } from "../../types"

export const ActionButtonsDecorator: ChatViewDecorator = {
	id: "action-buttons",
	render: (context: ChatViewContext) => (
		<ActionButtons
			chatState={context.chatState}
			messageHandlers={context.messageHandlers}
			messages={context.messages}
			mode={context.selectedModelInfo.mode}
			scrollBehavior={{
				scrollToBottomSmooth: context.scrollBehavior.scrollToBottomSmooth,
				disableAutoScrollRef: context.scrollBehavior.disableAutoScrollRef,
				showScrollToBottom: context.scrollBehavior.showScrollToBottom,
				virtuosoRef: context.scrollBehavior.virtuosoRef,
			}}
			task={context.task}
		/>
	),
}
