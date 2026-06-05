import type { DiracMessage, ExtensionState, TaskStatus } from "@shared/ExtensionMessage"

import { EmptyRequest } from "@shared/proto/dirac/common"
import { create } from "zustand"
import { StateServiceClient } from "@/shared/api/grpc-client"

interface ChatState {
	diracMessages: DiracMessage[]
	uiActionState?: ExtensionState["uiActionState"]
	activeVoiceStreamId?: string
	isApiRequestActive?: boolean
	taskStatus?: TaskStatus



	// Actions
	setDiracMessages: (messages: DiracMessage[]) => void
	updatePartialMessage: (message: DiracMessage) => void

	// Hydration
	hydrate: () => () => void
}

export const useChatStore = create<ChatState>((set) => ({
	diracMessages: [],
	uiActionState: undefined,
	activeVoiceStreamId: undefined,
	isApiRequestActive: false,
	taskStatus: undefined,



	setDiracMessages: (messages) => set({ diracMessages: messages }),


	updatePartialMessage: (message) =>
		set((state) => {
			const lastIndex = state.diracMessages.findLastIndex((msg) => msg.ts === message.ts)
			if (lastIndex !== -1) {
				const newMessages = [...state.diracMessages]
				newMessages[lastIndex] = message
				return { diracMessages: newMessages }
			}
			return state
		}),

	hydrate: () => {
		const cleanup = StateServiceClient.subscribeToState({} as EmptyRequest, {
			onResponse: (state) => {
				if (!state.stateJson) return
				const parsedState = JSON.parse(state.stateJson) as ExtensionState

				if (parsedState.diracMessages) {

					set((state) => {

						return {
							diracMessages: parsedState.diracMessages,
							uiActionState: parsedState.uiActionState,
							activeVoiceStreamId: parsedState.activeVoiceStreamId,
							isApiRequestActive: parsedState.isApiRequestActive,
							taskStatus: parsedState.taskStatus,

						}
					})
				}
			},
			onError: (error) => {
				console.error("Error in chatStore state subscription:", error)
			},
			onComplete: () => {},
		})
		return cleanup
	},
}))
