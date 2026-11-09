import { type Card, CardStatus } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useChatStore } from "@/features/chat/store/chatStore"
import { ModularCard } from "../ModularCard"

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
	useChatStore.getState().clearCardCollapsedStates()
})

describe("communication cards", () => {
	it("shows terminal communication content by default without interpreting content or exposing actions", () => {
		const onAction = vi.fn()
		render(
			<ModularCard
				card={communication({
					requireFeedback: true,
					requireApproval: true,
					actions: [{ label: "Approve", value: "approve" }],
					locations: [{ path: "secret.ts" }],
				})}
				isActive
				onAction={onAction}
			/>,
		)
		expect(screen.getByText("Dirac guided Curie")).toBeInTheDocument()
		expect(screen.getByText("Check Anchor§literal <button>Approve</button>")).toBeInTheDocument()
		expect(screen.getByText("Queued · publication-123")).toHaveClass("text-muted-foreground")
		expect(screen.queryByRole("button", { name: /Approve|Open secret/ })).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(onAction).not.toHaveBeenCalled()
	})

	it("previews long content and expands the complete original content on demand", () => {
		const body = `Useful first line\n${"long content ".repeat(100)}\nOriginal ending`
		render(<ModularCard card={communication({ body })} />)
		expect(screen.getByText(/Useful first line/)).toBeInTheDocument()
		expect(screen.queryByText(/Original ending/)).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show more" }))
		expect(document.getElementById("communication-content-communication:child:1")?.textContent).toBe(body)
		fireEvent.click(screen.getByRole("button", { name: "Show less" }))
		expect(screen.queryByText(/Original ending/)).not.toBeInTheDocument()
	})

	it("does not auto-collapse on a terminal transition but retains explicit user disclosure", () => {
		const card = communication({ status: CardStatus.RUNNING })
		const view = render(<ModularCard card={card} />)
		view.rerender(<ModularCard card={{ ...card, status: CardStatus.SUCCESS }} />)
		expect(screen.getByText(card.body!)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Dirac guided Curie" }))
		expect(screen.queryByText(card.body!)).not.toBeInTheDocument()
	})

	it("preserves action headers and actual content rather than substituting a generic receipt", () => {
		render(
			<ModularCard
				card={communication({
					taskletReceipt: {
						operation: "message",
						outcome: "queued",
						rows: [
							{
								operation: "guidance",
								title: "Audit",
								taskletId: "Curie",
								outcome: "queued",
								message: "Receipt fallback",
							},
						],
					},
				})}
			/>,
		)
		expect(screen.getByText("Dirac guided Curie")).toBeInTheDocument()
		expect(screen.getByText("Check Anchor§literal <button>Approve</button>")).toBeInTheDocument()
		expect(screen.queryByText("Receipt fallback")).not.toBeInTheDocument()
	})

	it("leaves unrelated terminal cards auto-collapsed", () => {
		render(<ModularCard card={communication({ communication: undefined, body: "Unrelated output" })} />)
		expect(screen.queryByText("Unrelated output")).not.toBeInTheDocument()
	})
})
