import { DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"

export type CardBodySuppressionPolicy = (message: DiracMessage) => boolean

/**
 * Assigns each card a sticky quiet-mode decision the first time it is encountered.
 * Later updates to the same card retain that decision, so toggling quiet mode only
 * affects cards that appear after the toggle.
 */
export function createCardBodySuppressionPolicy(isQuietModeEnabled: () => boolean): CardBodySuppressionPolicy {
	const quietDecisions = new Map<string, boolean>()

	return (message) => {
		if (message.content.type !== DiracMessageType.CARD) return false

		const { card } = message.content
		let quietDecision = quietDecisions.get(card.id)
		if (quietDecision === undefined) {
			quietDecision = isQuietModeEnabled()
			quietDecisions.set(card.id, quietDecision)
		}

		// Observational metadata never creates a modal; disclosure is independent of quiet mode.
		return Boolean((!card.communication && (card.requireApproval || card.requireFeedback)) || quietDecision)
	}
}
