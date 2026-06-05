/**
 * Custom hook to subscribe to controller state updates
 * Handles the diff/merge logic for streaming text and message tracking
 */

import type { DiracMessage } from "@shared/ExtensionMessage"
import { useCallback, useRef } from "react"
import { useTaskContext } from "../context/TaskContext"

interface ProcessedState {
	processedMessageIds: Set<string>
}

export const useProcessedMessages = () => {
	const processedRef = useRef<{ processedMessageIds: Set<string> }>({
		processedMessageIds: new Set(),
	})

	return processedRef.current
}

export const useCompletedAskMessages = () => {
	const { state } = useTaskContext()
	const processed = useProcessedMessages()

	const getCompletedAskMessages = useCallback(() => {
		const completedAsks: DiracMessage[] = []

		if (!state.diracMessages) {
			return completedAsks
		}

		for (const message of state.diracMessages) {
			if (message.content.type === "card" && !processed.processedMessageIds.has(message.id)) {
				const card = message.content.card
				if (card.requireApproval || card.requireFeedback) {
					completedAsks.push(message)
					processed.processedMessageIds.add(message.id)
				}
			}
		}

		return completedAsks
	}, [state.diracMessages, processed])

	return getCompletedAskMessages
}

export const useLastCompletedAskMessage = () => {
	const { state } = useTaskContext()

	const getLastCompletedAskMessage = useCallback((): DiracMessage | null => {
		if (!state.diracMessages) {
			return null
		}

		// Find the last card message that is complete and requires interaction
		for (let i = state.diracMessages.length - 1; i >= 0; i--) {
			const message = state.diracMessages[i]
			if (message.content.type === "card") {
				const card = message.content.card
				if (card.requireApproval || card.requireFeedback) {
					return message
				}
			}
		}

		return null
	}, [state.diracMessages])

	return getLastCompletedAskMessage()
}

export const useCompletionSignals = () => {
	const { state } = useTaskContext()

	const isTaskComplete = useCallback((): boolean => {
		if (!state.diracMessages || state.diracMessages.length === 0) {
			return false
		}

		const lastMessage = state.diracMessages[state.diracMessages.length - 1]
		if (!lastMessage || state.isApiRequestActive || state.activeVoiceStreamId) {
			return false
		}

		// In the new architecture, completion is often indicated by a Card with a specific header or status
		if (lastMessage.content.type === "card") {
			const card = lastMessage.content.card
			if (card.header.toLowerCase().includes("completed") || card.header.toLowerCase().includes("result")) {
				return true
			}
			if (card.status === "success" || card.status === "error") {
				// This might be too broad, but usually success/error on a final card means task is done
				// unless it's just a tool call.
			}
		}

		return false
	}, [state.diracMessages])

	const getCompletionMessage = useCallback((): DiracMessage | null => {
		if (!state.diracMessages || state.diracMessages.length === 0) {
			return null
		}

		return state.diracMessages[state.diracMessages.length - 1] || null
	}, [state.diracMessages])

	return {
		isTaskComplete,
		getCompletionMessage,
	}
}

export const useIsSpinnerActive = (): { isActive: boolean; startTime?: number } => {
	const { state } = useTaskContext()

	if (!state.diracMessages || state.diracMessages.length === 0) {
		return { isActive: false }
	}

	// Find the last "real" message (not api_status)
	let lastRealMessage = null
	for (let i = state.diracMessages.length - 1; i >= 0; i--) {
		const msg = state.diracMessages[i]
		if (msg.content.type !== "api_status") {
			lastRealMessage = msg
			break
		}
	}

	if (!lastRealMessage) {
		// If we only have api_status messages, check if the most recent one is "active"
		// In the absence of a 'running' flag, we assume the presence of api_status means activity
		const lastMsg = state.diracMessages[state.diracMessages.length - 1]
		return { isActive: true, startTime: lastMsg.ts }
	}

	// If the last real message is an interaction card, don't show spinner
	if (lastRealMessage.content.type === "card") {
		const card = lastRealMessage.content.card
		if (card.requireApproval || card.requireFeedback) {
			return { isActive: false }
		}

		// If it's a tool card that's still running, show spinner
		if (card.status === "running" || card.status === "building" || card.status === "pending") {
			return { isActive: true, startTime: lastRealMessage.ts }
		}
	}

	// If the last real message is partial, it's streaming
	if (state.activeVoiceStreamId === lastRealMessage.id) {
		return { isActive: true, startTime: lastRealMessage.ts }
	}

	if (state.isApiRequestActive) {
		return { isActive: true, startTime: Date.now() }
	}
	// If we have an api_status message AFTER the last real message, it likely means a new request started
	const lastMsg = state.diracMessages[state.diracMessages.length - 1]
	if (lastMsg.content.type === "api_status" && lastMsg.ts > lastRealMessage.ts) {
		return { isActive: true, startTime: lastMsg.ts }
	}

	return { isActive: false }
}
