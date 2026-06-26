/**
 * Tracks conversation turn boundaries and maintains a commit watermark.
 *
 * Messages before the watermark are immutable → safe for <Static> (print-once).
 * Messages after the watermark are live → rendered in Ink's dynamic region,
 * re-rendering on every state change (card status updates, body streaming, etc).
 *
 * The watermark advances when a NEW turn starts (inactive → active). At that point,
 * all previous cards are resolved (user responded, card auto-approved, etc.) and the
 * new API call has begun. This ensures interactive cards (e.g., plan_mode_respond,
 * ask_followup_question) remain in the dynamic region while awaiting user input.
 *
 * For task completion (no next turn), the watermark advances when the task status
 * is COMPLETED and there is no active turn.
 */

import { useRef } from "react"

export interface TurnCommitResult<T> {
	/** Messages from completed turns — safe for <Static> */
	committed: T[]
	/** Messages from the current (or no) turn — rendered dynamically */
	live: T[]
}

export function useTurnCommit<T>(
	messages: T[],
	isApiRequestActive: boolean,
	activeVoiceStreamId?: string,
	taskStatus?: string,
): TurnCommitResult<T> {
	const watermarkRef = useRef(0)
	const wasActiveRef = useRef(false)

	const isActive = isApiRequestActive || !!activeVoiceStreamId

	// On initial mount with no active turn, commit all existing messages.
	// These are from past conversation turns and are already terminal.
	if (!isActive && !wasActiveRef.current && watermarkRef.current === 0 && messages.length > 0) {
		watermarkRef.current = messages.length
	}

	// When a NEW turn starts, commit all messages from the previous turn.
	// At this point, all previous cards are resolved (user responded or auto-approved)
	// and the new API call has begun.
	if (isActive && !wasActiveRef.current && watermarkRef.current < messages.length) {
		watermarkRef.current = messages.length
	}

	// Task finished with no more turns coming — commit remaining messages.
	if (!isActive && taskStatus === "COMPLETED" && watermarkRef.current < messages.length) {
		watermarkRef.current = messages.length
	}

	wasActiveRef.current = isActive

	const committed = messages.slice(0, watermarkRef.current)
	const live = messages.slice(watermarkRef.current)

	// Return stable array references to prevent unnecessary re-renders.
	// .slice() creates a new array every render even when content is identical,
	// which can cascade into Ink's <Static> recalculating unnecessarily.
	const committedRef = useRef<T[]>([])
	const liveRef = useRef<T[]>([])

	if (committed.length !== committedRef.current.length || committed.some((msg, i) => msg !== committedRef.current[i])) {
		committedRef.current = committed
	}
	if (live.length !== liveRef.current.length || live.some((msg, i) => msg !== liveRef.current[i])) {
		liveRef.current = live
	}

	return {
		committed: committedRef.current,
		live: liveRef.current,
	}
}
