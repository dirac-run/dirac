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

const toggle = () => fireEvent.click(screen.getByRole("button", { name: /^Dirac guided Curie/ }))

beforeEach(() => {
	useChatStore.getState().clearCardCollapsedStates()
})

describe("communication cards", () => {
	it.each([undefined, false, true])("collapses legacy and new communication by default (collapsed:%s)", (collapsed) => {
		useChatStore.getState().setCardCollapsedState("communication:child:1", false, false)
		render(<ModularCard card={communication({ collapsed, do_not_auto_collapse: true })} />)
		expect(screen.getByRole("button", { name: "Dirac guided Curie" })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText(/Check Anchor/)).not.toBeInTheDocument()
		toggle()
		expect(screen.getByText("Check Anchor§literal <button>Approve</button>")).toBeInTheDocument()
	})

	it("discloses literal content without interpreting actions, locations, or receipt metadata", () => {
		const onAction = vi.fn()
		render(
			<ModularCard
				card={communication({
					status: CardStatus.WAITING_FOR_INPUT,
					requireFeedback: true,
					requireApproval: true,
					actions: [{ label: "Approve", value: "approve" }],
					locations: [{ path: "secret.ts" }],
					taskletReceipt: { operation: "message", outcome: "queued", rows: [] },
				})}
				isActive
				onAction={onAction}
			/>,
		)
		toggle()
		expect(screen.getByText("Check Anchor§literal <button>Approve</button>")).toBeInTheDocument()
		expect(screen.queryByText(/publication-123/)).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /Approve|Open secret/ })).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(onAction).not.toHaveBeenCalled()
	})

	it("exposes the full body with one disclosure and no nested truncation", () => {
		const body = `Useful first line\n${"long content ".repeat(100)}\nOriginal ending`
		render(<ModularCard card={communication({ body })} />)
		toggle()
		expect(document.getElementById("communication-content-communication:child:1")?.textContent).toBe(body)
		expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument()
	})

	it("preserves explicit disclosure across status/body/protocol updates and virtualization remounts", () => {
		const card = communication({ status: CardStatus.RUNNING, collapsed: false })
		const view = render(<ModularCard card={card} />)
		toggle()
		const updated = { ...card, status: CardStatus.SUCCESS, collapsed: true, body: "Updated content" }
		view.rerender(<ModularCard card={updated} />)
		expect(screen.getByText("Updated content")).toBeInTheDocument()
		view.unmount()
		const remount = render(<ModularCard card={updated} />)
		expect(screen.getByText("Updated content")).toBeInTheDocument()
		toggle()
		remount.rerender(<ModularCard card={{ ...updated, collapsed: false }} />)
		expect(screen.queryByText("Updated content")).not.toBeInTheDocument()
		remount.unmount()
		render(<ModularCard card={updated} />)
		expect(screen.queryByText("Updated content")).not.toBeInTheDocument()
	})

	it("renders markdown commands, questions and results as passive formatting", () => {
		const body =
			"## Question\n\n**Continue?**\n\n```bash\nnpm run deploy\n```\n\n- [x] Result recorded\n\n[Run](command:danger)\n\n![remote](https://example.com/image.png)\n\n<button>Approve</button>"
		const { container } = render(<ModularCard card={communication({ renderType: "markdown", body })} />)
		toggle()
		expect(screen.getByRole("heading", { name: "Question" })).toBeInTheDocument()
		expect(container.querySelector("pre code")?.textContent).toContain("npm run deploy")
		expect(container.querySelector("strong")?.textContent).toBe("Continue?")
		expect(container.querySelector("a, img, input, iframe, script")).toBeNull()
		expect(screen.getAllByRole("button")).toHaveLength(1)
		expect(screen.getByText("<button>Approve</button>")).toBeInTheDocument()
	})

	it("applies the same default to sibling communication", () => {
		render(<ModularCard card={communication({ header: "Curie messaged Planck", communication: { actor: "Curie" } })} />)
		expect(screen.getByRole("button", { name: "Curie messaged Planck" })).toHaveAttribute("aria-expanded", "false")
	})

	it("formats fenced bash in an actual root approval while keeping approval actionable", () => {
		const { container } = render(
			<ModularCard
				card={communication({
					communication: undefined,
					renderType: "markdown",
					body: "```bash\nnpm run deploy\n```",
					status: CardStatus.WAITING_FOR_INPUT,
					requireApproval: true,
				})}
				isActive
				onAction={vi.fn()}
			/>,
		)
		expect(container.textContent).toContain("npm run deploy")
		expect(screen.queryByText(/```/)).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument()
	})

	it("keeps root user requests actionable and unrelated terminal defaults unchanged", () => {
		const onAction = vi.fn()
		const view = render(
			<ModularCard
				card={communication({
					communication: undefined,
					status: CardStatus.WAITING_FOR_INPUT,
					requireApproval: true,
					actions: [{ label: "Approve", value: "approve" }],
				})}
				isActive
				onAction={onAction}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Approve" }))
		expect(onAction).toHaveBeenCalledWith("approve")
		view.unmount()
		render(<ModularCard card={communication({ communication: undefined, body: "Unrelated output" })} />)
		expect(screen.queryByText("Unrelated output")).not.toBeInTheDocument()
	})
})
