import { useEffect, useMemo, useRef, useState } from "react"
import { combineCardSequences } from "@shared/combineCardSequences"
import { useTurnCommit } from "./useTurnCommit"

export function useChatMessages(messages: any[], activeVoiceStreamId?: string, isApiRequestActive?: boolean) {
	const [taskSwitchKey, setTaskSwitchKey] = useState(0)
	const prevFirstMessageTs = useRef<number | null>(null)

	const displayMessages = useMemo(() => {
		const filtered = messages.filter((m) => {
			// Hide API status messages by default in the main chat view
			if (m.content?.type === "api_status") return false
			return true
		})
		return combineCardSequences(filtered)
	}, [messages])

	const firstMessageTs = displayMessages[0]?.ts ?? null
	useEffect(() => {
		if (prevFirstMessageTs.current !== null && firstMessageTs !== null && prevFirstMessageTs.current !== firstMessageTs) {
			process.stdout.write("\x1b[2J\x1b[H")
			setTaskSwitchKey((k) => k + 1)
		}
		prevFirstMessageTs.current = firstMessageTs
	}, [firstMessageTs])

	// Split messages by conversation turn boundary.
	// Committed messages (from completed turns) are immutable → safe for <Static>.
	// Live messages (from the active turn) are dynamic → re-render on state change.
	const { committed: committedMessages, live: liveMessages } = useTurnCommit(
		displayMessages,
		isApiRequestActive ?? false,
		activeVoiceStreamId,
	)

	return {
		displayMessages,
		committedMessages,
		liveMessages,
		taskSwitchKey,
		setTaskSwitchKey,
	}
}
