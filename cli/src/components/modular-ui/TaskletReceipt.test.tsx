import { type Card, CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { type TaskletReceipt, taskletReceiptTitle } from "@shared/taskletReceipt"
import { Box } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Classic JSX runtime requires React in scope.
import React from "react"
import stringWidth from "string-width"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatMessage } from "../ChatMessage"
import { CardInteractions } from "./CardInteractions"
import { ModularCard } from "./ModularCard"

const terminalSize = vi.hoisted(() => ({ columns: 120, rows: 40, resizeKey: 0 }))
vi.mock("../../hooks/useTerminalSize", () => ({ useTerminalSize: () => terminalSize }))
vi.mock("./CardInteractions", () => ({ CardInteractions: vi.fn(() => null) }))
const plain = (frame: string | undefined) => (frame ?? "").replace(/\u001B\[[0-9;]*m/g, "")

function receiptCard(receipt: TaskletReceipt): Card {
	return {
		id: "receipt",
		header: taskletReceiptTitle(receipt),
		status: CardStatus.SUCCESS,
		renderType: "text",
		taskletReceipt: receipt,
	}
}

const inspection: TaskletReceipt = {
	operation: "inspect",
	outcome: "retrieved",
	view: "pending",
	rows: [{ operation: "inspect", taskletId: "Planck 2", title: "Audit protocol", role: "Reviewer", outcome: "retrieved" }],
	returnedCount: 0,
	totalCount: 0,
}

describe("CLI tasklet operation receipts", () => {
	beforeEach(() => {
		terminalSize.columns = 120
		vi.mocked(CardInteractions).mockClear()
	})

	it("preserves inspection subject and outcome in regular, quiet and clipped timeline cards", () => {
		const card = receiptCard(inspection)
		for (const props of [{}, { suppressCardBody: true }, { tailOnly: true, maxContentLines: 1 }]) {
			const view = render(
				<ChatMessage message={{ id: card.id, ts: 1, content: { type: DiracMessageType.CARD, card } }} {...props} />,
			)
			const frame = plain(view.lastFrame())
			expect(frame).toContain("Inspect pending requests · Planck 2")
			expect(frame).toContain("[Retrieved]")
			expect(frame).not.toContain("Completed")
			view.unmount()
		}
	})

	it("keeps the outcome label visible at narrow widths", () => {
		terminalSize.columns = 24
		const view = render(
			<Box width={24}>
				<ModularCard card={receiptCard(inspection)} suppressBody />
			</Box>,
		)
		const frame = plain(view.lastFrame())
		expect(frame).toContain("[Retrieved]")
		expect(frame.split("\n")).toHaveLength(1)
		expect(stringWidth(frame)).toBeLessThanOrEqual(24)
		view.unmount()
	})

	it("renders accepted/queued labels and scoped decisions without child interactions", () => {
		const receipt: TaskletReceipt = {
			operation: "message",
			outcome: "partial_failure",
			rows: [
				{ operation: "guidance", taskletId: "Gödel", title: "Audit", outcome: "queued", message: "Check persistence first" },
				{
					operation: "permission_decision",
					title: "Build",
					outcome: "failed",
					request: "Run build",
					requestId: "opaque-request-id",
					decision: "approve",
					error: "Authority changed",
				},
			],
		}
		const card = {
			...receiptCard(receipt),
			status: CardStatus.WAITING_FOR_INPUT,
			requireApproval: true,
			requireFeedback: true,
		}
		const view = render(<ModularCard card={card} />)
		const frame = plain(view.lastFrame())
		expect(frame).toContain("[Partial failure]")
		expect(frame).toContain("Queued")
		expect(frame).toContain("Check persistence first")
		expect(frame).toContain("Gödel — Audit")
		expect(frame).toContain("this request only, within parent authority")
		expect(frame).toContain("Authority changed")
		expect(frame).toContain("consumption is not confirmed")
		expect(frame).not.toContain("opaque-request-id")
		expect(CardInteractions).not.toHaveBeenCalled()
		view.unmount()
	})
})
