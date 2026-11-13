import { type Card, CardStatus, type DiracMessage, DiracMessageType, type UIActionState } from "@shared/ExtensionMessage"

interface ApprovalQueueState {
	diracMessages: DiracMessage[]
	messageIndexById: Map<string, number>
	uiActionState?: UIActionState
}

/** Only live host-addressable waiters are decisions; card appearance never grants authority. */
export function selectPendingApprovalCards(state: ApprovalQueueState): Card[] {
	const cards: Card[] = []
	const seen = new Set<string>()
	for (const id of state.uiActionState?.pendingApprovalCardIds ?? []) {
		if (seen.has(id)) continue
		seen.add(id)
		const index = state.messageIndexById.get(id)
		const message = index === undefined ? undefined : state.diracMessages[index]
		if (message?.content.type !== DiracMessageType.CARD) continue
		const card = message.content.card
		if (card.id !== id || card.status !== CardStatus.WAITING_FOR_INPUT || !card.requireApproval) continue
		if (card.communication || card.rawInput?.isTasklet === true || card.taskletReceipt) continue
		cards.push(card)
	}
	return cards
}

/** Keep identity when requests arrive; after removal, select the next surviving neighbour. */
export function selectApprovalCardId(ids: readonly string[], selectedId?: string, previousIds: readonly string[] = []): string | undefined {
	if (selectedId && ids.includes(selectedId)) return selectedId
	const previousIndex = selectedId ? previousIds.indexOf(selectedId) : -1
	return ids[Math.min(Math.max(previousIndex, 0), ids.length - 1)]
}

/** Exact host input takes precedence over shortened display names or transcript markdown. */
export function approvalRequestText(card: Card): string {
	const commands = card.rawInput?.commands
	if (Array.isArray(commands)) {
		const texts = commands.map((command: unknown) => {
			if (typeof command === "string") return command
			if (command && typeof command === "object" && "command" in command && typeof command.command === "string") return command.command
			return undefined
		})
		if (texts.length > 0 && texts.every((text) => text !== undefined)) return texts.join("\n\n")
	}
	if (typeof card.rawInput?.command === "string") return card.rawInput.command
	return card.body ?? card.header
}
