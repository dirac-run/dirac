/**
 * Text input hook with cursor management and keyboard shortcut handling.
 *
 * Supports essential terminal shortcuts:
 * - Option+Left/Right: move by word (via escape sequences)
 * - Ctrl+A/E: start/end of line
 * - Ctrl+W: delete word backwards
 * - Ctrl+U: delete to start of line
 * - Ctrl+K: delete to end of line
 *
 * Note: Home/End keys are handled by useHomeEndKeys hook because Ink doesn't
 * expose them in useInput (it sets input='' for these keys).
 */

import { useCallback, useRef, useState } from "react"

import { OPTION_LEFT_SEQUENCES, OPTION_RIGHT_SEQUENCES } from "../constants/keyboard"

/**
 * Keyboard escape sequence types for special key combinations.
 * Only includes sequences that Ink passes through in the input string.
 */
type KeyboardSequence =
	| "option-left" // Move word left
	| "option-right" // Move word right
	| null

/**
 * Parse keyboard escape sequences for special key combinations.
 * Only handles Option+arrow - Home/End are handled by useHomeEndKeys.
 */
function parseKeyboardSequence(input: string): KeyboardSequence {
	if (OPTION_LEFT_SEQUENCES.has(input)) {
		return "option-left"
	}
	if (OPTION_RIGHT_SEQUENCES.has(input)) {
		return "option-right"
	}
	return null
}

/**
 * Find the start of the previous word from cursor position.
 */
export function findWordStart(text: string, cursorPos: number): number {
	let pos = cursorPos
	// Skip whitespace before cursor
	while (pos > 0 && /\s/.test(text[pos - 1])) {
		pos--
	}
	// Skip word characters
	while (pos > 0 && !/\s/.test(text[pos - 1])) {
		pos--
	}
	return pos
}

/**
 * Find the end of the next word from cursor position.
 */
export function findWordEnd(text: string, cursorPos: number): number {
	let pos = cursorPos
	// Skip word characters
	while (pos < text.length && !/\s/.test(text[pos])) {
		pos++
	}
	// Skip whitespace
	while (pos < text.length && /\s/.test(text[pos])) {
		pos++
	}
	return pos
}

export interface UseTextInputReturn {
	// State
	text: string
	cursorPos: number

	// Text manipulation
	setText: (text: string | ((prev: string) => string)) => void
	insertText: (text: string) => void
	setCursorPos: (pos: number | ((prev: number) => number)) => void

	// Deletion
	deleteCharBefore: () => void
	deleteCharsBefore: (count: number) => void
	deleteCharsAfter: (count: number) => void

	// Hot-path access (fresh values even between renders)
	getText: () => string
	getCursorPos: () => number

	// Keyboard shortcut handlers
	handleKeyboardSequence: (input: string) => boolean
	handleCtrlShortcut: (key: string) => boolean
}

/**
 * Hook for managing text input with cursor and keyboard shortcuts.
 */
export function useTextInput(): UseTextInputReturn {
	const [state, setState] = useState({ text: "", cursorPos: 0 })

	/**
	 * Authoritative mirror of the current state.
	 * Updated synchronously within every mutation to provide a "hot-path" source of truth.
	 * This allows input handlers to read the absolute latest state even if multiple events
	 * arrive faster than React can complete its asynchronous render cycle.
	 */
	// Synchronous mirror for hot-path access to avoid stale closures during rapid input
	const stateRef = useRef(state)

	// Helper to update state and ref atomically
	const updateState = useCallback(
		(updater: (prev: { text: string; cursorPos: number }) => { text: string; cursorPos: number }) => {
			const next = updater(stateRef.current)
			stateRef.current = next
			setState(next)
		},
		[],
	)

	// Text manipulation
	const setText = useCallback(
		(newText: string | ((prev: string) => string)) => {
			updateState((prev) => {
				const resolved = typeof newText === "function" ? newText(prev.text) : newText
				return {
					text: resolved,
					// Only update cursor to end if setting a direct value (not functional update)
					cursorPos: typeof newText !== "function" ? resolved.length : prev.cursorPos,
				}
			})
		},
		[updateState],
	)

	const insertText = useCallback(
		(insertedText: string) => {
			const normalizedText = insertedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
			updateState((prev) => ({
				text: prev.text.slice(0, prev.cursorPos) + normalizedText + prev.text.slice(prev.cursorPos),
				cursorPos: prev.cursorPos + normalizedText.length,
			}))
		},
		[updateState],
	)

	const setCursorPos = useCallback(
		(pos: number | ((prev: number) => number)) => {
			updateState((prev) => {
				const newPos = typeof pos === "function" ? pos(prev.cursorPos) : pos
				return {
					...prev,
					cursorPos: Math.max(0, Math.min(prev.text.length, newPos)),
				}
			})
		},
		[updateState],
	)

	// Deletion
	const deleteCharsBefore = useCallback(
		(count: number) => {
			updateState((prev) => {
				const actualCount = Math.min(count, prev.cursorPos)
				if (actualCount <= 0) return prev
				return {
					text: prev.text.slice(0, prev.cursorPos - actualCount) + prev.text.slice(prev.cursorPos),
					cursorPos: prev.cursorPos - actualCount,
				}
			})
		},
		[updateState],
	)

	const deleteCharBefore = useCallback(() => deleteCharsBefore(1), [deleteCharsBefore])

	const deleteCharsAfter = useCallback(
		(count: number) => {
			updateState((prev) => {
				const actualCount = Math.min(count, prev.text.length - prev.cursorPos)
				if (actualCount <= 0) return prev
				return {
					...prev,
					text: prev.text.slice(0, prev.cursorPos) + prev.text.slice(prev.cursorPos + actualCount),
				}
			})
		},
		[updateState],
	)

	const deleteCharAfter = useCallback(() => deleteCharsAfter(1), [deleteCharsAfter])

	const deleteWordBefore = useCallback(() => {
		updateState((prev) => {
			const wordStart = findWordStart(prev.text, prev.cursorPos)
			if (wordStart < prev.cursorPos) {
				return {
					text: prev.text.slice(0, wordStart) + prev.text.slice(prev.cursorPos),
					cursorPos: wordStart,
				}
			}
			return prev
		})
	}, [updateState])

	const deleteToStart = useCallback(() => {
		updateState((prev) => {
			if (prev.cursorPos > 0) {
				return {
					text: prev.text.slice(prev.cursorPos),
					cursorPos: 0,
				}
			}
			return prev
		})
	}, [updateState])

	const deleteToEnd = useCallback(() => {
		updateState((prev) => {
			if (prev.cursorPos < prev.text.length) {
				return {
					...prev,
					text: prev.text.slice(0, prev.cursorPos),
				}
			}
			return prev
		})
	}, [updateState])

	// Cursor movement (internal, used by handlers)
	const moveToStart = useCallback(() => setCursorPos(0), [setCursorPos])
	const moveToEnd = useCallback(() => setCursorPos((_pos) => stateRef.current.text.length), [setCursorPos])
	const moveWordLeft = useCallback(() => setCursorPos((pos) => findWordStart(stateRef.current.text, pos)), [setCursorPos])
	const moveWordRight = useCallback(() => setCursorPos((pos) => findWordEnd(stateRef.current.text, pos)), [setCursorPos])

	// Keyboard shortcut handlers
	const handleKeyboardSequence = useCallback(
		(input: string): boolean => {
			const seq = parseKeyboardSequence(input)
			if (!seq) return false

			switch (seq) {
				case "option-left":
					moveWordLeft()
					return true
				case "option-right":
					moveWordRight()
					return true
				default:
					return false
			}
		},
		[moveWordLeft, moveWordRight],
	)

	const handleCtrlShortcut = useCallback(
		(key: string): boolean => {
			switch (key.toLowerCase()) {
				case "a": // Ctrl+A - start of line
					moveToStart()
					return true
				case "e": // Ctrl+E - end of line
					moveToEnd()
					return true
				case "u": // Ctrl+U - delete to start
					deleteToStart()
					return true
				case "k": // Ctrl+K - delete to end
					deleteToEnd()
					return true
				case "w": // Ctrl+W - delete word backwards
					deleteWordBefore()
					return true
				default:
					return false
			}
		},
		[moveToStart, moveToEnd, deleteToStart, deleteToEnd, deleteWordBefore],
	)

	return {
		text: state.text,
		cursorPos: state.cursorPos,
		setText,
		insertText,
		setCursorPos,
		deleteCharBefore,
		deleteCharsBefore,
		deleteCharsAfter,
		handleKeyboardSequence,
		handleCtrlShortcut,
		getText: () => stateRef.current.text,
		getCursorPos: () => stateRef.current.cursorPos,
	}
}
