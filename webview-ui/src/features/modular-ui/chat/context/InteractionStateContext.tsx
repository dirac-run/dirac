import React, { createContext, useContext, useMemo } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { useChatStore } from "@/features/chat/store/chatStore"
export type InteractionState = "IDLE" | "RUNNING" | "AWAITING_RESPONSE" | "COMPLETED"

interface InteractionStateContextType {
	state: InteractionState
	isPlanMode: boolean
}

const InteractionStateContext = createContext<InteractionStateContextType | undefined>(undefined)

export const InteractionStateProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const { diracMessages: messages, activeVoiceStreamId, isApiRequestActive, taskStatus } = useChatStore()
	const mode = useSettingsStore((state: any) => state.mode)

	const interactionState = useMemo((): InteractionState => {
		if (messages.length === 0) return "IDLE"

		const lastMessage = messages.at(-1)
		if (!lastMessage) return "IDLE"

		if (isApiRequestActive || activeVoiceStreamId) return "RUNNING"

		if (taskStatus === "cancelled") return "AWAITING_RESPONSE"

		if (lastMessage.content.type === "card") {
			const card = lastMessage.content.card
			if (card.status === "waiting_for_input" || card.requireApproval || card.requireFeedback || card.actions?.length) {
				return "AWAITING_RESPONSE"
			}
			if (card.header === "Task Completed" && card.status === "success") {
				return "COMPLETED"
			}
		}

		// Default to running if we have messages but no clear completion/ask
		return "RUNNING"
	}, [messages, activeVoiceStreamId, isApiRequestActive, taskStatus])

	const value = useMemo(
		() => ({
			state: interactionState,
			isPlanMode: mode === "plan",
		}),
		[interactionState, mode],
	)

	return <InteractionStateContext.Provider value={value}>{children}</InteractionStateContext.Provider>
}

export const useInteractionState = () => {
	const context = useContext(InteractionStateContext)
	if (context === undefined) {
		throw new Error("useInteractionState must be used within an InteractionStateProvider")
	}
	return context
}
