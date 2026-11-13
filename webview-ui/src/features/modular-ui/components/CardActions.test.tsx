import { type Card, CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModularCard } from "../ModularCard"
import { CardActions } from "./CardActions"
import { useChatStore } from "@/features/chat/store/chatStore"
import { MessageRenderer } from "../chat/components/VirtuosoItemRenderer"
import type { MessageHandlers } from "../chat/types/chatTypes"

const choices = [
	{ id: "approve", label: "Approve this command" },
	{ id: "allow-network", label: "Approve + allow network access for this task" },
	{ id: "allow-files", label: "Approve + allow file writes for this task" },
	{ id: "reject", label: "Reject" },
]

const card: Card = {
	id: "command-approval",
	header: "Command permission",
	status: CardStatus.WAITING_FOR_INPUT,
	renderType: "text",
	requireApproval: true,
	commandApprovalChoices: choices,
}

beforeEach(() => useChatStore.setState({ uiActionState: undefined }))
afterEach(cleanup)

describe("command approval choices", () => {
	it.each([{ pendingApprovalCardIds: [] }, { pendingApprovalCardIds: [card.id] }])("never restores transcript approval buttons with authoritative queue $pendingApprovalCardIds", ({ pendingApprovalCardIds }) => {
		useChatStore.setState({ uiActionState: { globalButtons: [], cardButtons: [], sendingDisabled: false, pendingApprovalCardIds } })
		render(<CardActions card={card} isActive />)
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("renders only host-provided choices in a vertical stack, preserving their order", () => {
		render(<CardActions card={card} />)
		const buttons = screen.getAllByRole("button")
		expect(buttons.map((button) => button.textContent)).toEqual(choices.map((choice) => choice.label))
		expect(buttons[0].parentElement).toHaveClass("flex-col")
	})

	it.each(choices)("forwards only the selected typed choice $id through the card", (choice) => {
		const onAction = vi.fn()
		render(<ModularCard card={card} isActive onAction={onAction} />)
		fireEvent.click(screen.getByRole("button", { name: choice.label }))
		expect(onAction).toHaveBeenCalledExactlyOnceWith(
			choice.id === "reject" ? DiracAskResponse.REJECT : DiracAskResponse.APPROVE,
			choice.id,
		)
	})

	it.each(choices)("addresses the owning card when routing choice $id from the message row", (choice) => {
		useChatStore.getState().applyExtensionState({
			diracMessages: [{ id: card.id, ts: 1, content: { type: DiracMessageType.CARD, card } }],
		})
		const messageHandlers: MessageHandlers = {
			executeButtonAction: vi.fn().mockResolvedValue(undefined),
			handleSendMessage: vi.fn().mockResolvedValue(undefined),
			handleTaskCloseButtonClick: vi.fn(),
			startNewTask: vi.fn().mockResolvedValue(undefined),
		}
		render(<MessageRenderer messageId={card.id} isLastMessage expandedRows={{}} onToggleExpand={vi.fn()}
			onSetQuote={vi.fn()} messageHandlers={messageHandlers} activeCardId={card.id} />)
		fireEvent.click(screen.getByRole("button", { name: choice.label }))
		expect(messageHandlers.executeButtonAction).toHaveBeenCalledExactlyOnceWith(
			choice.id === "reject" ? DiracAskResponse.REJECT : DiracAskResponse.APPROVE,
			undefined, undefined, undefined, undefined, card.id, choice.id,
		)
	})

	it("offers only approve and reject for unknown commands", () => {
		render(<CardActions card={{ ...card, commandApprovalChoices: [choices[0], choices[3]] }} />)
		expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Approve this command", "Reject"])
	})

	it("preserves non-command approval callbacks and layout", () => {
		const onAction = vi.fn()
		render(<CardActions card={{ ...card, commandApprovalChoices: undefined }} onAction={onAction} />)
		const approve = screen.getByRole("button", { name: "Approve" })
		expect(approve.parentElement).toHaveClass("flex-wrap")
		fireEvent.click(approve)
		expect(onAction).toHaveBeenCalledExactlyOnceWith(DiracAskResponse.APPROVE)
	})

	it("does not show command choices for completed cards", () => {
		render(<CardActions card={{ ...card, status: CardStatus.SUCCESS }} />)
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})
})
