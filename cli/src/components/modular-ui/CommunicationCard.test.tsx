import { type Card, CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { Box } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Classic JSX runtime requires React in scope.
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cardDisplayBody, communicationBodyPreview } from "../../utils/card-body"
import { estimateTimelineMessageBodyRows, estimateTimelineMessageRows } from "../../utils/timeline-rows"
import { ChatMessage } from "../ChatMessage"
import { CardInteractions } from "./CardInteractions"
import { ModularCard } from "./ModularCard"

const terminalSize = vi.hoisted(() => ({ columns: 80, rows: 40, resizeKey: 0 }))
vi.mock("../../hooks/useTerminalSize", () => ({ useTerminalSize: () => terminalSize }))
vi.mock("./CardInteractions", () => ({ CardInteractions: vi.fn(() => null) }))
const plain = (frame: string | undefined) => (frame ?? "").replace(/\u001B\[[0-9;]*m/g, "")

function communication(overrides: Partial<Card> = {}): Card {
	return {
		id: "communication:child:1",
		header: "Dirac guided Curie",
		status: CardStatus.SUCCESS,
		renderType: "text",
		body: "Check Anchor§literal <button>Approve</button>",
		communication: { actor: "Dirac", detail: "Queued · publication-123" },
		...overrides,
	}
}

beforeEach(() => {
	vi.mocked(CardInteractions).mockClear()
	terminalSize.columns = 80
})

describe("CLI communication cards", () => {
	it("preserves the actual header and literal body even with receipt metadata", () => {
		const card = communication({
			status: CardStatus.WAITING_FOR_INPUT,
			requireFeedback: true,
			taskletReceipt: {
				operation: "message",
				outcome: "queued",
				rows: [
					{ operation: "guidance", title: "Audit", taskletId: "Curie", outcome: "queued", message: "Receipt fallback" },
				],
			},
		})
		const view = render(<ModularCard card={card} />)
		const frame = plain(view.lastFrame())
		expect(frame).toContain(card.header)
		expect(frame).toContain(card.body)
		expect(frame).toContain("Queued · publication-123")
		expect(frame).not.toContain("Receipt fallback")
		expect(cardDisplayBody(card)).toBe(card.body)
		expect(CardInteractions).not.toHaveBeenCalled()
		view.unmount()
	})

	it("retains full archived communication content in terminal scrollback", () => {
		const card = communication({ body: Array.from({ length: 30 }, (_, index) => `Line ${index}`).join("\n") })
		const view = render(
			<Box width={80}>
				<ModularCard card={card} />
			</Box>,
		)
		const frame = plain(view.lastFrame())
		expect(frame).toContain("Line 0")
		expect(frame).toContain("Line 29")
		expect(frame).not.toContain("scroll")
		view.unmount()
	})

	it("bounds live previews at the beginning while preserving explicit scroll windows", () => {
		const card = communication({ body: Array.from({ length: 30 }, (_, index) => `Line ${index}`).join("\n") })
		const view = render(
			<Box width={80}>
				<ModularCard card={card} maxBodyLines={6} />
			</Box>,
		)
		const frame = plain(view.lastFrame())
		expect(frame).toContain("Line 0")
		expect(frame).not.toContain("Line 29")
		expect(frame.split("\n").length).toBeLessThanOrEqual(8)
		view.rerender(
			<Box width={80}>
				<ModularCard card={card} maxBodyLines={3} scrollOffset={0} />
			</Box>,
		)
		expect(plain(view.lastFrame())).toContain("Line 29")
		view.unmount()
	})

	it("retains communication headers in clipped timeline rows and literal row accounting", () => {
		const card = communication({ renderType: "markdown", body: "# First\n\nLast", requireFeedback: true })
		const message = { id: card.id, ts: 1, content: { type: DiracMessageType.CARD as const, card } }
		const view = render(<ChatMessage message={message} tailOnly maxContentLines={4} />)
		expect(plain(view.lastFrame())).toContain(card.header)
		expect(estimateTimelineMessageBodyRows(message, 80)).toBe(3)
		expect(estimateTimelineMessageRows(message, 80)).toBe(4)
		view.unmount()
	})

	it("provides bounded literal nonverbose pipe-mode previews", () => {
		const body = `Anchor§literal <button>not a control</button>\n${"content\n".repeat(20)}Original ending`
		const preview = communicationBodyPreview(body, 80)
		expect(preview).toContain("Anchor§literal <button>not a control</button>")
		expect(preview).not.toContain("Original ending")
		expect(preview).toContain("… more communication content")
		expect(preview.split("\n")).toHaveLength(7)
	})
})
