import { type Card, CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { Box } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Classic JSX runtime requires React in scope.
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cardDisplayBody, communicationBodyPreview } from "../../utils/card-body"
import { estimateTimelineMessageBodyRows, estimateTimelineMessageRows } from "../../utils/timeline-rows"
import { ChatMessage } from "../ChatMessage"
import { CardBody } from "./CardBody"
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
	it("preserves role labels in communication headers", () => {
		const card = communication({ header: "Dirac → Curie [Scout] · Guidance" })
		const view = render(<ModularCard card={card} />)
		expect(plain(view.lastFrame())).toContain(card.header)
		expect(plain(view.lastFrame()).split("\n")).toHaveLength(1)
		view.unmount()
	})

	it.each([
		undefined,
		false,
		true,
	])("collapses communication including legacy collapsed:%s and preserves retrieval hints", (collapsed) => {
		const card = communication({
			collapsed,
			status: CardStatus.WAITING_FOR_INPUT,
			requireApproval: true,
			requireFeedback: true,
			actions: [{ label: "Approve", value: "approve" }],
			taskletReceipt: { operation: "message", outcome: "queued", rows: [] },
		})
		const view = render(<ModularCard card={card} />)
		const frame = plain(view.lastFrame())
		expect(frame).toContain(card.header)
		expect(frame).toContain("/agent → c")
		expect(frame).not.toContain(card.body)
		expect(frame.split("\n")).toHaveLength(1)
		expect(cardDisplayBody(card)).toBe(card.body)
		expect(CardInteractions).not.toHaveBeenCalled()
		view.unmount()
	})

	it.each([false, true])("agrees on collapsed rows for normal and clipped timeline paths (quiet:%s)", (suppressCardBody) => {
		const card = communication({ renderType: "markdown", body: "# First\n\nLast", requireFeedback: true })
		const message = { id: card.id, ts: 1, content: { type: DiracMessageType.CARD as const, card } }
		for (const tailOnly of [false, true]) {
			const view = render(
				<ChatMessage message={message} tailOnly={tailOnly} maxContentLines={4} suppressCardBody={suppressCardBody} />,
			)
			expect(plain(view.lastFrame())).toContain(card.header)
			expect(plain(view.lastFrame()).split("\n")).toHaveLength(estimateTimelineMessageRows(message, 80, suppressCardBody))
			expect(estimateTimelineMessageBodyRows(message, 80, suppressCardBody)).toBe(0)
			view.unmount()
		}
	})

	it("preserves escalation outcomes before disclosure hints at narrow widths", () => {
		terminalSize.columns = 30
		const card = communication({
			header: "Dirac → Curie [Scout] · Permission decision",
			taskletReceipt: { operation: "permission_decision", outcome: "requires_user_approval", rows: [] },
		})
		const view = render(
			<Box width={30}>
				<ModularCard card={card} />
			</Box>,
		)
		const frame = plain(view.lastFrame())
		expect(frame).toContain("[User approval needed]")
		expect(frame).not.toContain("/agent")
		expect(frame.split("\n")).toHaveLength(1)
		view.unmount()
	})

	it("also collapses sibling communication", () => {
		const view = render(
			<ModularCard card={communication({ header: "Curie messaged Planck", communication: { actor: "Curie" } })} />,
		)
		expect(plain(view.lastFrame())).toContain("Curie messaged Planck")
		expect(plain(view.lastFrame())).not.toContain("Check Anchor")
		view.unmount()
	})

	it("keeps literal body primitives free of path links or interpreted HTML", () => {
		const body = "Anchor§literal <button>Approve</button> src/index.ts\n```bash\nnpm run deploy\n```"
		const view = render(
			<Box width={80}>
				<CardBody body={body} renderType="text" literal stripLineAnchors={false} />
			</Box>,
		)
		expect(plain(view.lastFrame())).toContain(body)
		expect(view.lastFrame()).not.toContain("\u001b]8;")
		view.unmount()
	})

	it("does not change interactive root cards or unrelated tool disclosure", () => {
		const view = render(
			<ModularCard
				card={communication({
					communication: undefined,
					collapsed: true,
					status: CardStatus.WAITING_FOR_INPUT,
					requireFeedback: true,
				})}
			/>,
		)
		expect(plain(view.lastFrame())).toContain("Check Anchor")
		expect(CardInteractions).toHaveBeenCalled()
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
