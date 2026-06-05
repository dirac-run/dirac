/**
 * Tracks conversation turn boundaries and maintains a commit watermark.
 *
 * The backend guarantees that when an API call (conversation turn) completes,
 * all cards from that turn are in terminal status (success, error, skipped, etc).
 * This hook exploits that invariant:
 *
 *  - Messages before the watermark are immutable → safe for <Static> (print-once).
 *  - Messages after the watermark are live → rendered in Ink's dynamic region,
 *    re-rendering on every state change (card status updates, body streaming, etc).
 *
 * The watermark advances synchronously when the turn transitions from active to
 * inactive (isApiRequestActive drops to false AND activeVoiceStreamId clears).
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
): TurnCommitResult<T> {
	const watermarkRef = useRef(0)
	const wasActiveRef = useRef(false)

	const isActive = isApiRequestActive || !!activeVoiceStreamId

	// On initial mount with no active turn, commit all existing messages.
	// These are from past conversation turns and are already terminal.
	if (!isActive && !wasActiveRef.current && watermarkRef.current === 0 && messages.length > 0) {
		watermarkRef.current = messages.length
	}

	// When the turn transitions from active → inactive, commit everything.
	// The backend guarantees all cards from the completed turn are terminal.
	if (!isActive && wasActiveRef.current) {
		watermarkRef.current = messages.length
	}

	wasActiveRef.current = isActive

	return {
		committed: messages.slice(0, watermarkRef.current),
		live: messages.slice(watermarkRef.current),
	}
}
