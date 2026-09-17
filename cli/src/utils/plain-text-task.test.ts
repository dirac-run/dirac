import {
	CardStatus,
	type Card,
	DiracMessageType,
	TaskStatus,
	UIActionButtonType,
	type ExtensionState,
} from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	approveCardForPlainTextYolo,
	getStandaloneCardDisposition,
	StandaloneCardDisposition,
} from "./standalone-card-policy"
import { emitTaskStartedMessage } from "./task-start-output"
import { evaluatePlainTextTaskTerminalState } from "./plain-text-task"

describe("emitTaskStartedMessage", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("writes structured task_started JSON to stdout in json mode", () => {
		const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		emitTaskStartedMessage("task-123", true)

		expect(stdoutWriteSpy).toHaveBeenCalledWith('{"type":"task_started","taskId":"task-123"}\n')
		expect(stderrWriteSpy).not.toHaveBeenCalled()
	})

	it("writes human-readable task started line to stderr in non-json mode", () => {
		const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		emitTaskStartedMessage("task-456", false)

		expect(stderrWriteSpy).toHaveBeenCalledWith("Task started: task-456\n")
		expect(stdoutWriteSpy).not.toHaveBeenCalled()
	})
})


describe("approveCardForPlainTextYolo", () => {
	it("forwards the primary action value when approving a new-task card", async () => {
		const submitCardResponse = vi.fn().mockResolvedValue(undefined)
		const controller = { task: { submitCardResponse } }
		const card: Card = {
			id: "new-task-card",
			header: "New Task",
			status: CardStatus.WAITING_FOR_INPUT,
			renderType: "markdown",
			actions: [{ label: "Approve New Task", value: "new_task", primary: true }],
		}

		await approveCardForPlainTextYolo(controller, card)

		expect(submitCardResponse).toHaveBeenCalledWith(
			card.id,
			DiracAskResponse.APPROVE,
			undefined,
			undefined,
			undefined,
			"new_task",
		)
	})

	it("fails when no active task can receive the approval", async () => {
		const controller = { task: undefined }
		const card = {
			id: "approval-card",
			header: "Approval",
			status: CardStatus.WAITING_FOR_INPUT,
			renderType: "markdown",
		} as Card

		await expect(approveCardForPlainTextYolo(controller, card)).rejects.toThrow("without an active task")
	})
})

describe("getStandaloneCardDisposition", () => {
	const waitingCard = {
		id: "card",
		header: "Card",
		status: CardStatus.WAITING_FOR_INPUT,
		renderType: "markdown",
	} as Card

	it("auto-approves approval cards only in yolo mode", () => {
		expect(getStandaloneCardDisposition({ ...waitingCard, requireApproval: true }, true, false)).toBe(
			StandaloneCardDisposition.AUTO_APPROVE,
		)
		expect(getStandaloneCardDisposition({ ...waitingCard, requireApproval: true }, false, false)).toBe(
			StandaloneCardDisposition.FAIL_FOR_APPROVAL,
		)
	})

	it("never fabricates feedback in yolo mode", () => {
		expect(getStandaloneCardDisposition({ ...waitingCard, requireFeedback: true }, true, false)).toBe(
			StandaloneCardDisposition.FAIL_FOR_FEEDBACK,
		)
	})

	it("does not act on interaction cards while only viewing history", () => {
		expect(getStandaloneCardDisposition({ ...waitingCard, requireApproval: true }, true, true)).toBe(
			StandaloneCardDisposition.NONE,
		)
	})
})

describe("evaluatePlainTextTaskTerminalState", () => {
	it("rejects immediately when a Task Failed error card is present", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			diracMessages: [
				{
					id: "1",
					ts: Date.now(),
					content: {
						type: DiracMessageType.CARD,
						card: {
							id: "fail-card",
							header: "Task Failed",
							status: CardStatus.ERROR,
							body: "[YOLO MODE] Task failed: Too many consecutive mistakes (3).",
							renderType: "markdown",
						},
					},
				},
			],
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("reject")
		expect(result.error?.message).toBe("[YOLO MODE] Task failed: Too many consecutive mistakes (3).")
	})

	it("resolves when taskStatus is COMPLETED", () => {
		const state = {
			taskStatus: TaskStatus.COMPLETED,
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("resolve")
	})

	it("rejects when taskStatus is CANCELLED in normal execution", () => {
		const state = {
			taskStatus: TaskStatus.CANCELLED,
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state, false)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("reject")
		expect(result.error?.message).toBe("Task was cancelled.")
	})

	it("resolves when taskStatus is CANCELLED in isViewTaskOnly mode", () => {
		const state = {
			taskStatus: TaskStatus.CANCELLED,
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state, true)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("resolve")
	})

	it("rejects when global buttons have both NEW_TASK and PROCEED (mistake limit projection)", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			uiActionState: {
				globalButtons: [
					{ action: UIActionButtonType.NEW_TASK },
					{ action: UIActionButtonType.PROCEED },
				],
			},
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("reject")
		expect(result.error?.message).toBe("Mistake limit reached. Task halted in YOLO mode.")
	})

	it("returns non-terminal when task is running without terminal signals", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			uiActionState: {
				globalButtons: [],
			},
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(false)
	})
})
