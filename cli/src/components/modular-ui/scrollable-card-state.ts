/**
 * Shared mutable ref to track whether a scrollable card body is currently
 * mounted and should consume arrow-key events.
 *
 * When active, the chat input handler skips up/down arrow processing
 * (history navigation, cursor movement) so the card can scroll instead.
 */
export const scrollableCardActive = { current: false }
