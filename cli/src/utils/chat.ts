import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"

/**
 * Yolo mode auto-approves tool use, commands, browser actions, etc. so the AI can work
 * uninterrupted. But some ask types genuinely need user input -- you can't auto-approve
 * "task completed, what next?" or a followup question the AI is asking the user.
 *
 * In the new architecture, we check if a Card requires approval or feedback.
 */
export function isYoloSuppressed(yolo: boolean, message: DiracMessage | undefined): boolean {
	if (!yolo || !message) return false

	if (message.content.type === DiracMessageType.CARD) {
		const { card } = message.content
		// If it requires approval (tool call) and we are in YOLO, it's suppressed.
		// If it requires feedback (followup), it's NOT suppressed even in YOLO.
		if (card.requireApproval) return true
		if (card.requireFeedback) return false
	}

	return false
}

/**
 * Get the type of prompt needed for a message
 */
export function getAskPromptType(message: DiracMessage): "confirmation" | "text" | "options" | "none" {
	if (message.content.type === DiracMessageType.CARD) {
		const { card } = message.content
		if (card.requireFeedback) {
			if (card.actions && card.actions.length > 0) {
				return "options"
			}
			return "text"
		}
		if (card.requireApproval) {
			return "confirmation"
		}
	}

	// For markdown messages, we usually don't prompt unless it's a specific completion signal
	// but in the new architecture, completion is usually a Card or a final Markdown.
	// If it's a partial markdown, it's definitely "none".
	if (message.content.type === DiracMessageType.MARKDOWN) return "none"

	return "none"
}

/**
 * Parse options from a card message
 */
export function parseAskOptions(message: DiracMessage): string[] {
	if (message.content.type === DiracMessageType.CARD && message.content.card.actions) {
		return message.content.card.actions.map((a) => a.label)
	}
	return []
}

/**
 * Expand pasted text placeholders back to actual content
 * Replaces [Pasted text #N +X lines] with the stored content
 */
export function expandPastedTexts(text: string, pastedTexts: Map<number, string>): string {
	return text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (match, num) => {
		const content = pastedTexts.get(Number.parseInt(num, 10))
		return content ?? match
	})
}

export function getInputStorageKey(controller: any, taskId?: string): string {
	// Use taskId if available, otherwise fall back to controller instance
	return taskId || (controller?.task?.taskId ?? "default")
}
