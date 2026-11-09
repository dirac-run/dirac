import { DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { createCardBodySuppressionPolicy } from "./quiet-mode"

function cardMessage(id: string, requireApproval = false): DiracMessage {
	return {
		id,
		ts: 1,
		content: {
			type: DiracMessageType.CARD,
			card: {
				id,
				header: id,
				status: "success" as any,
				renderType: "text",
				body: `${id} body`,
				requireApproval,
			},
		},
	}
}

describe("createCardBodySuppressionPolicy", () => {
	it("applies quiet mode only to cards first encountered after each toggle", () => {
		let quietMode = false
		const shouldSuppress = createCardBodySuppressionPolicy(() => quietMode)
		const beforeToggle = cardMessage("before-toggle")

		expect(shouldSuppress(beforeToggle)).toBe(false)

		quietMode = true
		expect(shouldSuppress(beforeToggle)).toBe(false)
		expect(shouldSuppress(cardMessage("while-quiet"))).toBe(true)

		quietMode = false
		expect(shouldSuppress(cardMessage("while-quiet"))).toBe(true)
		expect(shouldSuppress(cardMessage("after-disable"))).toBe(false)
	})

	it("always suppresses approval cards in the transcript", () => {
		const shouldSuppress = createCardBodySuppressionPolicy(() => false)
		expect(shouldSuppress(cardMessage("approval", true))).toBe(true)
	})

	it("keeps communication disclosure independent of quiet mode and ignores observational approval flags", () => {
		let quietMode = false
		const shouldSuppress = createCardBodySuppressionPolicy(() => quietMode)
		const message = cardMessage("communication", true)
		if (message.content.type !== DiracMessageType.CARD) throw new Error("Expected card")
		message.content.card.communication = { actor: "Curie" }
		message.content.card.collapsed = true
		message.content.card.requireFeedback = true
		expect(shouldSuppress(message)).toBe(false)
		quietMode = true
		expect(shouldSuppress(message)).toBe(false)
		expect(
			shouldSuppress({
				...message,
				content: { ...message.content, card: { ...message.content.card, id: "new-communication" } },
			}),
		).toBe(true)
	})

	it("never suppresses markdown messages", () => {
		const shouldSuppress = createCardBodySuppressionPolicy(() => true)
		const message: DiracMessage = {
			id: "assistant",
			ts: 1,
			content: {
				type: DiracMessageType.MARKDOWN,
				role: "assistant",
				content: "Visible response",
			},
		}
		expect(shouldSuppress(message)).toBe(false)
	})
})
