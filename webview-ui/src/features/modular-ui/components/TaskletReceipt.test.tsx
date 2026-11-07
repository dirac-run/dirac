import { type Card, CardStatus } from "@shared/ExtensionMessage"
import { type TaskletReceipt, taskletReceiptTitle } from "@shared/taskletReceipt"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ModularCardBody } from "./ModularCardBody"
import { ModularCardHeader } from "./ModularCardHeader"

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
	rows: [{ operation: "inspect", title: "Audit protocol", outcome: "retrieved" }],
	returnedCount: 0,
	totalCount: 0,
}

describe("tasklet operation receipts", () => {
	it("labels the inspected subject independently from the operation outcome", () => {
		render(<ModularCardHeader card={receiptCard(inspection)} contentId="body" isCollapsed onToggleCollapse={vi.fn()} />)
		expect(screen.getByText("Inspect pending requests · Audit protocol")).toBeInTheDocument()
		expect(screen.getByText("Retrieved")).toBeInTheDocument()
		expect(screen.queryByText("Completed")).not.toBeInTheDocument()
		expect(screen.queryByText("Pending")).not.toBeInTheDocument()
	})

	it("renders batch results, original messages and scoped decisions without interactive controls", () => {
		const receipt: TaskletReceipt = {
			operation: "message",
			outcome: "partial_failure",
			rows: [
				{ operation: "guidance", title: "Audit", outcome: "queued", message: "Check persistence first" },
				{
					operation: "permission_decision",
					title: "Build",
					outcome: "failed",
					request: "Run build",
					decision: "approve",
					error: "Authority changed",
				},
			],
		}
		const onAction = vi.fn()
		const card = {
			...receiptCard(receipt),
			status: CardStatus.WAITING_FOR_INPUT,
			requireApproval: true,
			requireFeedback: true,
			actions: [{ label: "Approve", value: "approve" }],
		}
		render(<ModularCardBody card={card} isActive onAction={onAction} />)
		expect(screen.getByText("Queued")).toBeInTheDocument()
		expect(screen.getByText("Failed")).toBeInTheDocument()
		expect(screen.getByText("Check persistence first")).toBeInTheDocument()
		expect(screen.getByText(/this request only, within parent authority/)).toBeInTheDocument()
		expect(screen.getByText(/Authority changed/)).toBeInTheDocument()
		expect(screen.getByText(/consumption is not confirmed/)).toBeInTheDocument()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(onAction).not.toHaveBeenCalled()
	})

	it("renders observed child state separately from retrieved status", () => {
		const receipt: TaskletReceipt = {
			...inspection,
			view: "status",
			rows: [{ ...inspection.rows[0], observedState: "settlement_failed" }],
		}
		render(<ModularCardBody card={receiptCard(receipt)} />)
		expect(screen.getByText("Retrieved")).toBeInTheDocument()
		expect(screen.getByText("Observed: Settlement failed")).toBeInTheDocument()
	})
})
