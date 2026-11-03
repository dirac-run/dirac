import { type Card, CardStatus, type DiracMessage, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { createTaskletPresentationCard, type TaskletPresentationStatus } from "@shared/taskletPresentation"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useChatStore } from "@/features/chat/store/chatStore"
import { MessageRenderer } from "./chat/components/VirtuosoItemRenderer"
import { InteractionState, projectInteractionState } from "./chat/context/InteractionStateContext"
import type { MessageHandlers } from "./chat/types/chatTypes"
import { ModularCard } from "./ModularCard"

function tasklet(status: TaskletPresentationStatus, id = "child-alpha", overrides: Partial<Card> = {}): Card {
	return {
		...createTaskletPresentationCard({
			taskletId: id,
			title: "Review implementation",
			prompt: "Inspect the public interface",
			createdAt: 1000,
			status,
			result: status === "completed" ? "Complete retained result" : undefined,
			communications: ["Question for parent: may I proceed?"],
			activity: ["Diagnostic: inspected module"],
			usage: { tokensIn: 100, tokensOut: 20, reasoningTokens: 3, cost: 0.5 },
		}),
		...overrides,
	}
}

function cardMessage(card: Card): DiracMessage {
	return { id: card.id, ts: 1000, content: { type: DiracMessageType.CARD, card } }
}

const root: DiracMessage = {
	id: "root",
	ts: 0,
	content: { type: DiracMessageType.MARKDOWN, content: "Parent task" },
}
const spawn = cardMessage({ id: "spawn", header: "Delegations accepted", status: CardStatus.SUCCESS, renderType: "text" })

const messageHandlers: MessageHandlers = {
	executeButtonAction: vi.fn(),
	handleSendMessage: vi.fn(),
	handleTaskCloseButtonClick: vi.fn(),
	startNewTask: vi.fn(),
}

// Exercise the production virtualized row's message selector and complete card rendering.
function StoreCards() {
	const ids = useChatStore((state) => state.visibleMessageIds)
	return (
		<div>
			{ids.map((id, index) => (
				<MessageRenderer
					expandedRows={{}}
					isLastMessage={index === ids.length - 1}
					key={id}
					messageHandlers={messageHandlers}
					messageId={id}
					onSetQuote={vi.fn()}
					onToggleExpand={vi.fn()}
				/>
			))}
		</div>
	)
}

function hydrate(cards: Card[], extra: DiracMessage[] = []) {
	useChatStore.getState().applyExtensionState({
		diracMessages: [root, spawn, ...cards.map(cardMessage), ...extra],
		presentationSurfaceId: "root-surface",
		presentationOffset: -1,
		taskStatus: TaskStatus.STREAMING_TEXT,
	})
}

function patch(card: Card, offset: number) {
	expect(
		useChatStore.getState().applyPresentationBatch({
			surfaceId: "root-surface",
			operations: [{ type: "patch_card", id: card.id, offset, patch: card }],
		}),
	).toBe("applied")
}

function expand() {
	fireEvent.click(screen.getByTitle(/^Expand .*Review implementation$/))
}

beforeEach(() => {
	useChatStore.getState().setDiracMessages([])
	useChatStore.getState().clearCardCollapsedStates()
	useChatStore.setState({
		presentationSurfaceId: undefined,
		presentationOffset: -1,
		taskStatus: undefined,
		uiActionState: undefined,
		goal: undefined,
	})
})

describe("webview informational tasklet cards", () => {
	it.each<TaskletPresentationStatus>([
		"running",
		"waiting",
		"completed",
		"failed",
		"interrupted",
	])("renders stable identity and %s state with retained content", (status) => {
		const { container } = render(<ModularCard card={tasklet(status)} isActive onAction={vi.fn()} />)
		expect(screen.getByText(/child-alpha/)).toBeInTheDocument()
		expect(container.textContent?.toLowerCase()).toContain(status === "waiting" ? "parent" : status)
		expand()
		expect(screen.getByText(/Inspect the public interface/)).toBeInTheDocument()
		expect(screen.getByText(/Question for parent: may I proceed/)).toBeInTheDocument()
		expect(screen.getByText(/Diagnostic: inspected module/)).toBeInTheDocument()
		if (status === "completed") expect(screen.getByText(/Complete retained result/)).toBeInTheDocument()
		expect(container.querySelector(".modular-card-actions")).not.toBeInTheDocument()
	})

	it("never offers child approval, custom actions, file navigation or completion UI even with stale action fields", () => {
		const card = tasklet("waiting", "child-alpha", {
			requireApproval: true,
			requireFeedback: true,
			actions: [{ label: "Approve child directly", value: "approve" }],
			locations: [{ path: "src/secret.ts" }],
			icon: DiracIcon.COMPLETE,
		})
		const onAction = vi.fn()
		const { rerender, container } = render(<ModularCard card={card} isActive onAction={onAction} />)
		expand()
		expect(screen.queryByRole("button", { name: /Approve|Reject|Open src/ })).not.toBeInTheDocument()
		expect(container.querySelector(".modular-completion")).not.toBeInTheDocument()
		rerender(<ModularCard card={{ ...card, status: CardStatus.SUCCESS }} isActive onAction={onAction} />)
		expect(screen.queryByRole("button", { name: "View Changes" })).not.toBeInTheDocument()
		expect(onAction).not.toHaveBeenCalled()
	})

	it("keeps tasklet-marked legacy/incomplete projections informational", () => {
		const card = tasklet("waiting", "child-alpha", {
			rawOutput: undefined,
			requireApproval: true,
			actions: [{ label: "Approve child directly", value: "approve" }],
			icon: DiracIcon.COMPLETE,
			collapsed: false,
		})
		const { container } = render(<ModularCard card={card} isActive onAction={vi.fn()} />)
		expect(screen.queryByRole("button", { name: /Approve|Reject|View Changes/ })).not.toBeInTheDocument()
		expect(container.querySelector(".modular-completion")).not.toBeInTheDocument()
	})

	it("treats child text as literal content and keeps previews bounded", () => {
		const card = createTaskletPresentationCard({
			taskletId: "literal",
			title: "Review implementation",
			prompt: "Anchor§literal <button>Approve</button>",
			createdAt: 1000,
			status: "completed",
			result: "r".repeat(3000),
			communications: [],
			activity: [],
		})
		const { container } = render(<ModularCard card={card} />)
		expand()
		expect(screen.getByText(/Anchor§literal <button>Approve<\/button>/)).toBeInTheDocument()
		expect(container.textContent).toContain("preview; inspect tasklet for full contents")
		expect(container.textContent).not.toContain("r".repeat(1201))
		expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
	})
})

describe("webview tasklet store/render integration", () => {
	it.each<TaskletPresentationStatus>([
		"completed",
		"failed",
		"interrupted",
	])("renders running → waiting → %s updates on the actual stable row", (status) => {
		hydrate([tasklet("running")])
		render(<StoreCards />)
		act(() => patch(tasklet("waiting"), 0))
		expect(screen.getByText("Waiting for parent")).toBeInTheDocument()
		act(() => patch(tasklet(status), 1))
		expect(screen.getByText(status[0].toUpperCase() + status.slice(1))).toBeInTheDocument()
		expect(useChatStore.getState().taskStatus).toBe(TaskStatus.STREAMING_TEXT)
		expect(useChatStore.getState().visibleMessageIds.filter((id) => id === "tasklet:child-alpha")).toHaveLength(1)
	})

	it("updates ongoing tasklets after spawn completion, settles siblings independently and reopens the same ID", () => {
		hydrate([tasklet("running"), tasklet("waiting", "child-beta")])
		render(<StoreCards />)
		const original = screen.getByText(/child-alpha/).closest("button")
		expect(original).not.toBeNull()
		act(() => patch(tasklet("completed"), 0))
		expect(screen.getByText(/child-alpha/)).toBeInTheDocument()
		expect(screen.getByText(/child-beta/)).toBeInTheDocument()
		expect(useChatStore.getState().taskStatus).toBe(TaskStatus.STREAMING_TEXT)
		expect(projectInteractionState({ hasTask: true, taskStatus: useChatStore.getState().taskStatus })).toBe(
			InteractionState.RUNNING,
		)
		expect(useChatStore.getState().visibleMessageIds).toEqual([spawn.id, "tasklet:child-alpha", "tasklet:child-beta"])
		act(() => patch(tasklet("running"), 1))
		expect(screen.getAllByText(/child-alpha/)).toHaveLength(1)
		expect(useChatStore.getState().diracMessages.filter((message) => message.id === "tasklet:child-alpha")).toHaveLength(1)
		expect(screen.getByText(/child-alpha/).closest("button")).toBe(original)
	})

	it("restores previews in a fresh mount and retains the user's expansion through terminal/reopen updates", () => {
		hydrate([tasklet("waiting")])
		const first = render(<StoreCards />)
		expand()
		act(() => patch(tasklet("completed"), 0))
		expect(screen.getByText(/Complete retained result/)).toBeInTheDocument()
		const saved = structuredClone(useChatStore.getState().diracMessages)
		first.unmount()
		act(() => {
			useChatStore.getState().clearCardCollapsedStates()
			useChatStore
				.getState()
				.applyExtensionState({ diracMessages: saved, presentationSurfaceId: "restored", presentationOffset: -1 })
		})
		render(<StoreCards />)
		expand()
		expect(screen.getByText(/Complete retained result/)).toBeInTheDocument()
		act(() => {
			expect(
				useChatStore.getState().applyPresentationBatch({
					surfaceId: "restored",
					operations: [{ type: "patch_card", id: "tasklet:child-alpha", offset: 0, patch: tasklet("running") }],
				}),
			).toBe("applied")
		})
		expect(screen.getByTitle(/^Collapse .*Review implementation$/)).toBeInTheDocument()
		expect(screen.getByText(/Inspect the public interface/)).toBeInTheDocument()
	})

	it("counts only hidden accounting snapshots once across updates, replay and restoration, never display usage", () => {
		const accounting = cardMessage({
			id: "tasklet-usage:child-alpha",
			header: "Usage",
			renderType: "text",
			status: CardStatus.SUCCESS,
			rawOutput: {
				source: "tasklet",
				taskletId: "child-alpha",
				tokensIn: 100,
				tokensOut: 20,
				reasoningTokens: 3,
				cost: 0.5,
			},
		})
		hydrate([tasklet("running")], [accounting])
		render(<StoreCards />)
		expect(useChatStore.getState().apiMetrics.totalCost).toBe(0.5)
		expect(screen.queryByText("Usage")).not.toBeInTheDocument()
		act(() => patch(tasklet("completed"), 0))
		expect(useChatStore.getState().apiMetrics.totalCost).toBe(0.5)
		const batch = {
			surfaceId: "root-surface",
			operations: [
				{
					type: "patch_card" as const,
					id: accounting.id,
					offset: 1,
					patch: {
						rawOutput: {
							source: "tasklet",
							taskletId: "child-alpha",
							tokensIn: 150,
							tokensOut: 30,
							reasoningTokens: 4,
							cost: 0.75,
						},
					},
				},
			],
		}
		act(() => {
			useChatStore.getState().applyPresentationBatch(batch)
			useChatStore.getState().applyPresentationBatch(batch)
		})
		expect(useChatStore.getState().apiMetrics.totalCost).toBe(0.75)
		act(() => useChatStore.getState().setDiracMessages(structuredClone(useChatStore.getState().diracMessages)))
		expect(useChatStore.getState().apiMetrics).toMatchObject({ totalCost: 0.75, totalTokensIn: 150, totalReasoningTokens: 4 })
		expect(within(screen.getByTitle(/^Expand .*Review implementation$/)).queryByText("Usage")).not.toBeInTheDocument()
	})
})
