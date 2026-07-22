import { CardStatus, type Card } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "@/core/controller"
import { approveCardForPlainTextYolo } from "./plain-text-task"
import { emitTaskStartedMessage } from "./task-start-output"

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
	it("forwards the primary action value when approving a new-task card", () => {
		const submitCardResponse = vi.fn().mockResolvedValue(undefined)
		const controller = { task: { submitCardResponse } } as unknown as Controller
		const card: Card = {
			id: "new-task-card",
			header: "New Task",
			status: CardStatus.WAITING_FOR_INPUT,
			renderType: "markdown",
			actions: [{ label: "Approve New Task", value: "new_task", primary: true }],
		}

		approveCardForPlainTextYolo(controller, card)

		expect(submitCardResponse).toHaveBeenCalledWith(
			card.id,
			DiracAskResponse.APPROVE,
			undefined,
			undefined,
			undefined,
			"new_task",
		)
	})
})
