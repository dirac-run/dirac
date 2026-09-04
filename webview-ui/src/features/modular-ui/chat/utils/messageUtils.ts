/**
 * Utility functions for projecting chat messages into the modular chat surface.
 */

import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { getSubagentUsage } from "@shared/subagentUsage"

/**
 * Filter messages that should be visible in the chat.
 *
 * This keeps the frontend render list flat. The backend projection owns card state;
 * this pass only hides presentation-empty rows and superseded API status noise.
 */
export function filterVisibleMessages(messages: DiracMessage[]): DiracMessage[] {
	// Find the index of the last api_status message that has a request field
	let lastApiStatusIndex = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		const msgContent = messages[i].content
		if (msgContent.type === DiracMessageType.API_STATUS) {
			if (msgContent.status.request) {
				lastApiStatusIndex = i
				break
			}
		}
	}

	return messages.filter((message, index) => {
		const content = message.content
		if (content.type === DiracMessageType.CARD && getSubagentUsage(content.card)) return false
		if (content.type === DiracMessageType.CHECKPOINT) {
			return true
		}

		if (content.type === DiracMessageType.API_STATUS) {
			// Show if it's the latest one (current request) OR if it has cost/token data (completed request)
			return index === lastApiStatusIndex || content.status.cost !== undefined || content.status.tokensIn !== undefined
		}

		if (content.type === DiracMessageType.MARKDOWN) {
			if ((content.content ?? "") === "" && (content.images?.length ?? 0) === 0) {
				return false
			}
		}

		return true
	})
}
