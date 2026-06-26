/**
 * Utility to insert text at the current cursor position in a textarea.
 */
export function insertTextAtCursor(
	textArea: HTMLTextAreaElement,
	textToInsert: string,
	currentValue: string,
	cursorPosition: number,
): { newValue: string; newCursorPosition: number } {
	const before = currentValue.substring(0, cursorPosition)
	const after = currentValue.substring(cursorPosition)
	const newValue = before + textToInsert + after
	const newCursorPosition = cursorPosition + textToInsert.length

	return { newValue, newCursorPosition }
}

/**
 * Utility to get the coordinates (top, left) of the cursor in a textarea.
 * This is useful for positioning floating menus.
 */
export function getCursorCoordinates(textArea: HTMLTextAreaElement): { top: number; left: number } {
	const { selectionStart, offsetLeft, offsetTop } = textArea
	// This is a simplified version. For more accuracy, we might need a more robust library
	// or a hidden mirror div to calculate exact pixel coordinates.
	// For now, we'll return basic offsets.
	return {
		top: offsetTop,
		left: offsetLeft,
	}
}
