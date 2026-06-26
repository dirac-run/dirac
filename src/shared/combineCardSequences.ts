import { DiracMessage, DiracMessageType } from "./ExtensionMessage"

/**
 * Combines card updates in a message sequence.
 * Only the latest version of each card (by ID) is kept.
 * Cards are kept in their original relative order, but updated with the latest content.
 */
export function combineCardSequences(messages: DiracMessage[]): DiracMessage[] {
	const cardMap = new Map<string, { index: number; message: DiracMessage }>()
	const result: DiracMessage[] = []

	for (const msg of messages) {
		if (msg.content.type === DiracMessageType.CARD) {
			const existing = cardMap.get(msg.content.card.id)
			if (existing !== undefined) {
				// Update existing card in place
				result[existing.index] = msg
			} else {
				// New card, add to result and map
				cardMap.set(msg.content.card.id, { index: result.length, message: msg })
				result.push(msg)
			}
		} else {
			result.push(msg)
		}
	}

	return result
}
