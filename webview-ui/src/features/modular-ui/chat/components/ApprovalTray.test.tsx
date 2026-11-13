import { type Card, CardStatus, type DiracMessage, DiracMessageType, type UIActionState } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useChatStore } from "@/features/chat/store/chatStore"
import { CardActions } from "../../components/CardActions"
import { approvalRequestText, selectApprovalCardId, selectPendingApprovalCards } from "../utils/approvalQueue"
import { ApprovalTray } from "./ApprovalTray"

const choices: NonNullable<Card["commandApprovalChoices"]> = [
	{ id: "approve", label: "Approve this command" },
	{ id: "opaque-grant-files", label: "Host grant files", category: "filesystem", access: "mutate" },
	{ id: "opaque-grant-software", label: "Host grant software", category: "software", access: "mutate" },
	{ id: "reject", label: "Reject" },
]
const approval = (id: string, patch: Partial<Card> = {}): Card => ({
	id, header: `Execute ${id}`, status: CardStatus.WAITING_FOR_INPUT, renderType: "markdown",
	requireApproval: true, rawInput: { commands: [{ command: `echo '${id}'`, cwd: "/exact/workspace" }] },
	body: "Sandbox: workspace-write", commandApprovalChoices: choices, ...patch,
})
const message = (card: Card): DiracMessage => ({ id: card.id, ts: 1, content: { type: DiracMessageType.CARD, card } })
function hydrate(cards: Card[], pendingApprovalCardIds = cards.map((card) => card.id)) {
	useChatStore.getState().applyExtensionState({
		diracMessages: cards.map(message),
		uiActionState: { globalButtons: [], cardButtons: [], sendingDisabled: false, activeCardId: cards[0]?.id, pendingApprovalCardIds },
	})
}

beforeEach(() => hydrate([]))
afterEach(cleanup)

describe("approval queue", () => {
	it("uses host pending IDs, excluding orphaned, final, informational and missing cards", () => {
		const cards = [approval("live"), approval("orphan"), approval("done", { status: CardStatus.SUCCESS }),
		approval("child", { communication: { actor: "Child" } }), approval("tasklet", { rawInput: { isTasklet: true } }),
		approval("question", { requireApproval: false })]
		hydrate(cards, ["live", "done", "child", "tasklet", "question", "missing", "live"])
		expect(selectPendingApprovalCards(useChatStore.getState()).map((card) => card.id)).toEqual(["live"])
	})

	it("never derives authority from a waiting card or activeCardId when pending IDs are absent", () => {
		hydrate([approval("orphan")], [])
		useChatStore.setState({ uiActionState: { activeCardId: "orphan" } as UIActionState })
		expect(selectPendingApprovalCards(useChatStore.getState())).toEqual([])
	})

	it("keeps identity on insertion and selects the surviving neighbour on removal", () => {
		expect(selectApprovalCardId(["new", "a", "b"], "b", ["a", "b"])).toBe("b")
		expect(selectApprovalCardId(["a", "c"], "b", ["a", "b", "c"])).toBe("c")
		expect(selectApprovalCardId([], "b", ["a", "b"])).toBeUndefined()
	})

	it("uses exact commands rather than display labels or shortened markdown", () => {
		const command = "printf '%s\\n' '/a/very/long/path'\n# second line"
		expect(approvalRequestText(approval("a", { rawInput: { commands: [{ command, displayName: "short" }] } }))).toBe(command)
		expect(approvalRequestText(approval("a", { rawInput: undefined, body: "Exact request\nsecond line" }))).toBe("Exact request\nsecond line")
	})
})

describe("ApprovalTray", () => {
	it("is absent without a live queue", () => {
		render(<ApprovalTray messageHandlers={{ executeButtonAction: vi.fn() }} />)
		expect(screen.queryByRole("region", { name: "Pending approval" })).not.toBeInTheDocument()
	})

	it("shows a single request with exactly three action rows and neutral option styling", () => {
		hydrate([approval("a")])
		render(<ApprovalTray messageHandlers={{ executeButtonAction: vi.fn() }} />)
		expect(screen.queryByRole("navigation")).not.toBeInTheDocument()
		const once = screen.getByRole("button", { name: "Approve once" })
		expect(once.parentElement).toHaveClass("approval-tray-once")
		expect(once.parentElement?.children).toHaveLength(2)
		expect(once.parentElement?.parentElement?.children).toHaveLength(3)
		for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("approval-tray-option")
		expect(screen.getByRole("button", { name: "All filesystem:mutate This task" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "All software:mutate This task" })).toBeInTheDocument()
		const details = screen.getByLabelText("Request details").closest("details")
		expect(details).not.toHaveAttribute("open")
		fireEvent.click(screen.getByLabelText("Request details"))
		expect(details).toHaveAttribute("open")
		expect(details).toHaveTextContent("/exact/workspace")
		expect(details).toHaveTextContent("Sandbox: workspace-write")
	})

	it("keeps selected identity when requests arrive and advances when it resolves", () => {
		hydrate([approval("a"), approval("b")])
		render(<ApprovalTray messageHandlers={{ executeButtonAction: vi.fn() }} />)
		fireEvent.click(screen.getByRole("button", { name: "Next approval" }))
		expect(screen.getByText("2 of 2")).toBeInTheDocument()
		act(() => hydrate([approval("new"), approval("a"), approval("b"), approval("c")]))
		expect(screen.getByText("3 of 4")).toBeInTheDocument()
		expect(screen.getByRole("region", { name: "Pending approval" })).toHaveAttribute("data-card-id", "b")
		act(() => hydrate([approval("new"), approval("a"), approval("c")]))
		expect(screen.getByRole("region", { name: "Pending approval" })).toHaveAttribute("data-card-id", "c")
	})

	it.each([
		["Approve once", DiracAskResponse.APPROVE, "approve"],
		["Reject", DiracAskResponse.REJECT, "reject"],
		["All filesystem:mutate This task", DiracAskResponse.APPROVE, "opaque-grant-files"],
		["All software:mutate This task", DiracAskResponse.APPROVE, "opaque-grant-software"],
	])("dispatches %s only to the selected card without composer content", async (name, action, choiceId) => {
		hydrate([approval("a"), approval("b")])
		const executeButtonAction = vi.fn().mockResolvedValue(undefined)
		render(<ApprovalTray messageHandlers={{ executeButtonAction }} />)
		fireEvent.click(screen.getByRole("button", { name: "Next approval" }))
		fireEvent.click(screen.getByRole("button", { name }))
		await waitFor(() => expect(executeButtonAction).toHaveBeenCalledExactlyOnceWith(action, undefined, undefined, undefined, undefined, "b", choiceId))
	})

	it("never invents reusable grants for an unclassified request", () => {
		hydrate([approval("a", { commandApprovalChoices: [choices[0], choices[3]] })])
		render(<ApprovalTray messageHandlers={{ executeButtonAction: vi.fn() }} />)
		expect(screen.getAllByRole("button")).toHaveLength(2)
	})

	it("supports one-shot non-command approvals without adding a grant", async () => {
		hydrate([approval("a", { commandApprovalChoices: undefined })])
		const executeButtonAction = vi.fn().mockResolvedValue(undefined)
		render(<ApprovalTray messageHandlers={{ executeButtonAction }} />)
		fireEvent.click(screen.getByRole("button", { name: "Approve once" }))
		await waitFor(() => expect(executeButtonAction).toHaveBeenCalledWith(DiracAskResponse.APPROVE, undefined, undefined, undefined, undefined, "a", undefined))
	})

	it("prevents duplicate in-flight decisions and reports failure", async () => {
		hydrate([approval("a")])
		let reject!: (error: Error) => void
		const executeButtonAction = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
		render(<ApprovalTray messageHandlers={{ executeButtonAction }} />)
		fireEvent.click(screen.getByRole("button", { name: "Approve once" }))
		fireEvent.click(screen.getByRole("button", { name: "Reject" }))
		expect(executeButtonAction).toHaveBeenCalledTimes(1)
		await act(async () => reject(new Error("Host rejected the decision")))
		expect(screen.getByRole("alert")).toHaveTextContent("Host rejected the decision")
		expect(screen.getByRole("button", { name: "Approve once" })).toBeEnabled()
	})

	it("keeps transcript approval controls hidden after a waiter leaves the authoritative queue", () => {
		const card = approval("a")
		hydrate([card])
		const { rerender } = render(<CardActions card={card} isActive />)
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		act(() => hydrate([card], []))
		rerender(<CardActions card={card} isActive />)
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})
})
