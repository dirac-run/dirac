import "should"
import { CardStatus, DiracMessage, DiracMessageType, TaskStatus, UIActionButtonType } from "@shared/ExtensionMessage"
import { TaskState } from "../TaskState"
import { projectUIActionState } from "./ui-projector"

describe("projectUIActionState", () => {
	it("shows only Start New Task for a completed task", () => {
		const state = new TaskState()
		state.status = TaskStatus.COMPLETED

		const uiState = projectUIActionState(state, [], 3)

		uiState.globalButtons.should.deepEqual([
			{
				label: "Start New Task",
				action: UIActionButtonType.NEW_TASK,
				primary: true,
			},
		])
		uiState.cardButtons.should.deepEqual([])
	})

	it("keeps Resume for a cancelled task", () => {
		const state = new TaskState()
		state.status = TaskStatus.CANCELLED

		const uiState = projectUIActionState(state, [], 3)

		uiState.globalButtons.should.deepEqual([
			{
				label: "Resume",
				action: UIActionButtonType.APPROVE,
				primary: true,
			},
		])
	})

	it("enables steering input while a task is busy", () => {
		const state = new TaskState()
		state.status = TaskStatus.EXECUTING_TOOL

		projectUIActionState(state, [], 3).sendingDisabled.should.equal(false)
	})

	it("only disables sending during cancellation", () => {
		const cancelling = new TaskState()
		cancelling.status = TaskStatus.CANCELLING
		projectUIActionState(cancelling, [], 3).sendingDisabled.should.equal(true)

		const awaitingCard = new TaskState()
		awaitingCard.status = TaskStatus.AWAITING_USER_INPUT
		awaitingCard.waitingCardIds = ["card-1"]
		const messages: DiracMessage[] = [
			{
				id: "card-1",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "card-1",
						header: "Proposed Plan",
						status: CardStatus.WAITING_FOR_INPUT,
						renderType: "markdown" as const,
						requireFeedback: true,
						body: "1. Implement the fix",
					},
				},
			},
		]

		const uiState = projectUIActionState(awaitingCard, messages, 3)

		uiState.sendingDisabled.should.equal(false)
		uiState.activeCardId!.should.equal("card-1")
	})

	it("does not let a stale plan-response flag hide busy controls", () => {
		const state = new TaskState()
		state.status = TaskStatus.BUILDING_TOOL_CALL
		state.isAwaitingPlanResponse = true

		const uiState = projectUIActionState(state, [], 3)

		uiState.sendingDisabled.should.equal(false)
		uiState.globalButtons.should.deepEqual([
			{
				label: "Cancel",
				action: UIActionButtonType.CANCEL,
				style: "secondary",
			},
		])
	})

	it("skips stale terminal card ids when projecting the active interaction", () => {
		const state = new TaskState()
		state.status = TaskStatus.EXECUTING_TOOL
		state.waitingCardIds = ["stale", "active"]
		const messages: DiracMessage[] = [
			{
				id: "stale",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "stale",
						header: "Resolved",
						status: CardStatus.SUCCESS,
						renderType: "text",
						requireApproval: true,
					},
				},
			},
			{
				id: "active",
				ts: 2,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "active",
						header: "Approve",
						status: CardStatus.WAITING_FOR_INPUT,
						renderType: "text",
						requireApproval: true,
					},
				},
			},
		]

		projectUIActionState(state, messages, 3).activeCardId!.should.equal("active")
	})
	it("projects only live unanswered approval waiters in registration order", () => {
		const state = new TaskState()
		state.status = TaskStatus.AWAITING_USER_INPUT
		const ids = ["second", "first", "answered", "aborted", "final", "feedback", "informational"]
		const messages: DiracMessage[] = ids.map((id, ts) => ({
			id, ts, content: {
				type: DiracMessageType.CARD, card: {
					id, header: id, renderType: "text",
					status: id === "final" ? CardStatus.SUCCESS : CardStatus.WAITING_FOR_INPUT,
					requireApproval: id !== "feedback",
				}
			},
		}))
		for (const id of ids.filter((id) => id !== "informational")) {
			const controller = new AbortController()
			if (id === "aborted") controller.abort()
			state.pendingCardInteractions.set(id, {
				signal: controller.signal,
				response: id === "answered" ? { action: "approve" } : undefined,
			})
		}
		projectUIActionState(state, messages, 3).pendingApprovalCardIds!.should.deepEqual(["second", "first"])
		projectUIActionState(state, (id) => messages.find((message) => message.id === id), 3)
			.pendingApprovalCardIds!.should.deepEqual(["second", "first"])
		state.status = TaskStatus.CANCELLING
		projectUIActionState(state, messages, 3).pendingApprovalCardIds!.should.deepEqual([])
		state.status = TaskStatus.AWAITING_USER_INPUT
		state.abort = true
		projectUIActionState(state, messages, 3).pendingApprovalCardIds!.should.deepEqual([])
	})
})
