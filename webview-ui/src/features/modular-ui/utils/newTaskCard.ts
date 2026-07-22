import { Card, DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"

const NEW_TASK_TOOL_NAME = "new_task"

export function isNewTaskCard(card: Card): boolean {
	return card.rawInput?.tool === NEW_TASK_TOOL_NAME
}

export function findActiveNewTaskCard(messages: DiracMessage[], activeCardId?: string): Card | undefined {
	if (!activeCardId) return undefined

	const activeMessage = messages.find((message) => message.id === activeCardId)
	if (activeMessage?.content.type !== DiracMessageType.CARD) return undefined

	return isNewTaskCard(activeMessage.content.card) ? activeMessage.content.card : undefined
}
