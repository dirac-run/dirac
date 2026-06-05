/**
 * Thrown by waitForInteraction when the user sends a plain text message
 * instead of responding to a card's approval/feedback request.
 *
 * This signals that the tool should be skipped and the user's message
 * forwarded to the LLM as the next user input.
 */
export class ToolSkippedByUserMessage extends Error {
	constructor(
		public readonly userMessage: string,
		public readonly userImages?: string[],
		public readonly userFiles?: string[],
	) {
		super(`Tool skipped by user with message: "${userMessage}"`)
		this.name = "ToolSkippedByUserMessage"
	}
}
