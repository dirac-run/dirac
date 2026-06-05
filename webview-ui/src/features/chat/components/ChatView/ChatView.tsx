import { useChatStore } from "@/features/chat/store/chatStore"

import { useMount } from "react-use"
import { InteractionStateProvider } from "@/features/modular-ui/chat/context/InteractionStateContext"
import { ModularChatView } from "@/features/modular-ui/chat/ModularChatView"

// Import types
import { ChatViewProps } from "@/features/modular-ui/chat/types/chatTypes"

import { useChatState } from "@/features/modular-ui/chat/hooks/useChatState"


// ChatViewProps is now imported from types/chatTypes


const ChatViewContent = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	const messages = useChatStore((state) => state.diracMessages)
	const chatState = useChatState(messages)
	const { textAreaRef } = chatState

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus()
	})

	return (
		<ModularChatView
			hideAnnouncement={hideAnnouncement}
			isHidden={isHidden}
			showAnnouncement={showAnnouncement}
			showHistoryView={showHistoryView}
		/>
	)
}

const ChatView = (props: ChatViewProps) => (
	<InteractionStateProvider>
		<ChatViewContent {...props} />
	</InteractionStateProvider>
)

export default ChatView
