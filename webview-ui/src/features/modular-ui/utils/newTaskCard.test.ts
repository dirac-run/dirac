import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { findActiveNewTaskCard, isNewTaskCard } from "./newTaskCard"

const newTaskCard = {
	id: "new-task-card",
	header: "New Task",
	status: CardStatus.WAITING_FOR_INPUT,
	renderType: "markdown" as const,
	body: "# Exact context\n\nPreserve whitespace.",
	rawInput: { tool: "new_task" },
}

describe("newTaskCard", () => {
	it("identifies cards using machine-readable new_task metadata", () => {
		expect(isNewTaskCard(newTaskCard)).toBe(true)
		expect(isNewTaskCard({ ...newTaskCard, rawInput: { tool: "read_file" } })).toBe(false)
	})

	it("returns the active new-task card body without transforming it", () => {
		const messages = [
			{
				id: newTaskCard.id,
				ts: 1,
				content: { type: DiracMessageType.CARD, card: newTaskCard },
			},
		]

		expect(findActiveNewTaskCard(messages, newTaskCard.id)?.body).toBe(newTaskCard.body)
	})

	it("does not return an inactive or unrelated card", () => {
		const messages = [
			{
				id: "other-card",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: { ...newTaskCard, id: "other-card", rawInput: { tool: "read_file" } },
				},
			},
		]

		expect(findActiveNewTaskCard(messages, "other-card")).toBeUndefined()
	})
})
