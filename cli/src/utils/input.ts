/**
 * Input filtering utilities for CLI components
 */

/**
 * Check if input contains mouse escape sequences from terminal mouse tracking.
 * AsciiMotionCli enables mouse tracking which generates sequences like [<35;46;17M
 * These should be filtered out of text input handlers.
 *
 * NOTE: This must NOT filter keyboard escape sequences like Option+arrow keys.
 * Mouse sequences have specific patterns with coordinates (e.g., [<35;46;17M).
 */
/**
 * Check if input is a terminal response sequence (e.g., Device Attributes, Window manipulation).
 * These are often sent by the terminal in response to queries from libraries like ink-picture.
 * We use an aggressive filter that discards any unknown escape sequences.
 */
export function isTerminalResponseSequence(input: string, key: any): boolean {
	if (!input) return false

	// If Ink recognized this as a functional key or a modifier key, it's not garbage.
	if (
		key.upArrow ||
		key.downArrow ||
		key.leftArrow ||
		key.rightArrow ||
		key.return ||
		key.tab ||
		key.escape ||
		key.backspace ||
		key.delete ||
		key.ctrl ||
		key.meta
	) {
		return false
	}

	// If it's not a recognized key, but contains characteristic terminal response patterns,
	// or any escape characters, it's almost certainly garbage from a terminal query.
	return (
		input.includes("\x1b") ||
		input.includes("\u001b") ||
		input.includes("_GOK") || // Kitty graphics protocol
		/\[\??\d+(;\d+)*[a-zA-Z]/.test(input) // CSI sequences (e.g., [4;991;1710t)
	)
}

export function isMouseEscapeSequence(input: string): boolean {
	// Mouse events look like: \x1b[<35;46;17M (SGR mouse format)
	// They contain [< followed by numbers, semicolons, and end with M or m
	return input.includes("[<") && /\[<\d+;\d+;\d+[Mm]/.test(input)
}
