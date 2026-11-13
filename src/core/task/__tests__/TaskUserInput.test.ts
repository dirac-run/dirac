import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { TaskState } from "../TaskState"
import { submitCardResponse } from "../TaskUserInput"

function waitingState(...cardIds: string[]): TaskState {
	const state = new TaskState()
	state.waitingCardIds = cardIds
	for (const id of cardIds) state.pendingCardInteractions.set(id, { signal: new AbortController().signal })
	return state
}

describe("TaskUserInput addressed card actions", () => {
	for (const response of [DiracAskResponse.APPROVE, DiracAskResponse.REJECT, "custom_action"]) {
		it(`does not route an empty-card ${response} to the foreground waiter`, async () => {
			const taskState = waitingState("foreground-card")

			await assert.rejects(submitCardResponse({ taskState }, { cardId: "", response }), /exact card ID/)

			assert.equal(taskState.askResponse, undefined)
			assert.equal(taskState.askResponseAction, undefined)
			assert.equal(taskState.askResponseCardId, undefined)
			assert.equal(taskState.pendingCardInteractions.get("foreground-card")?.response, undefined)
		})
	}

	it("ignores a retired card instead of answering the new request", async () => {
		const taskState = waitingState("new-card")

		await assert.rejects(submitCardResponse({ taskState }, { cardId: "retired-card", response: DiracAskResponse.APPROVE }), /no pending interaction/)

		assert.equal(taskState.askResponse, undefined)
		assert.equal(taskState.askResponseCardId, undefined)
		assert.equal(taskState.pendingCardInteractions.get("new-card")?.response, undefined)
	})

	it("accepts an identified non-head request without writing shared response fields", async () => {
		const taskState = waitingState("first-card", "second-card")

		await submitCardResponse({ taskState }, { cardId: "second-card", response: DiracAskResponse.REJECT, value: "second" })

		assert.equal(taskState.pendingCardInteractions.get("second-card")?.response?.response, DiracAskResponse.REJECT)
		assert.equal(taskState.pendingCardInteractions.get("second-card")?.response?.value, "second")
		assert.equal(taskState.pendingCardInteractions.get("first-card")?.response, undefined)
		assert.equal(taskState.askResponse, undefined)
		assert.equal(taskState.askResponseCardId, undefined)
		assert.equal(taskState.lastWaitingCardId, "first-card")
	})

	it("preserves unaddressed chat as input to the FIFO head rather than approval authority", async () => {
		const taskState = waitingState("first-card", "second-card")

		await submitCardResponse({ taskState }, { cardId: "", response: DiracAskResponse.MESSAGE, text: "approved" })

		assert.equal(taskState.pendingCardInteractions.get("first-card")?.response?.response, DiracAskResponse.MESSAGE)
		assert.equal(taskState.pendingCardInteractions.get("first-card")?.response?.text, "approved")
		assert.equal(taskState.pendingCardInteractions.get("second-card")?.response, undefined)
		assert.equal(taskState.askResponse, undefined)
		assert.equal(taskState.didRejectTool, false)
	})

	it("retains legacy non-card follow-up input in the shared tuple", async () => {
		const taskState = new TaskState()
		await submitCardResponse({ taskState }, {
			cardId: "", response: DiracAskResponse.MESSAGE, text: "Continue", images: ["image.png"], files: ["notes.txt"],
		})
		assert.equal(taskState.askResponse, DiracAskResponse.MESSAGE)
		assert.equal(taskState.askResponseText, "Continue")
		assert.deepEqual(taskState.askResponseImages, ["image.png"])
		assert.deepEqual(taskState.askResponseFiles, ["notes.txt"])
		assert.equal(taskState.askResponseCardId, undefined)
	})

	it("does not overwrite an accepted response before its waiter consumes it", async () => {
		const taskState = waitingState("card")
		await submitCardResponse({ taskState }, { cardId: "card", response: DiracAskResponse.APPROVE, value: "first" })
		await assert.rejects(submitCardResponse({ taskState }, { cardId: "card", response: DiracAskResponse.REJECT, value: "duplicate" }), /no longer awaiting/)
		assert.equal(taskState.pendingCardInteractions.get("card")?.response?.response, DiracAskResponse.APPROVE)
		assert.equal(taskState.pendingCardInteractions.get("card")?.response?.value, "first")
	})

	it("keeps a command approval choice on its addressed interaction only", async () => {
		const taskState = waitingState("first-card", "command-card")
		await submitCardResponse({ taskState }, {
			cardId: "command-card",
			response: DiracAskResponse.APPROVE,
			commandApprovalChoiceId: "allow-filesystem-mutate",
		})
		assert.equal(taskState.pendingCardInteractions.get("command-card")?.response?.commandApprovalChoiceId, "allow-filesystem-mutate")
		assert.equal(taskState.pendingCardInteractions.get("first-card")?.response, undefined)
		assert.equal(taskState.askResponse, undefined)
		await assert.rejects(submitCardResponse({ taskState }, {
			cardId: "command-card", response: DiracAskResponse.APPROVE, commandApprovalChoiceId: "replacement",
		}), /no longer awaiting/)
		assert.equal(taskState.pendingCardInteractions.get("command-card")?.response?.commandApprovalChoiceId, "allow-filesystem-mutate")
	})

	it("does not infer a capability grant from generic approval text or value", async () => {
		const taskState = waitingState("command-card")
		await submitCardResponse({ taskState }, {
			cardId: "command-card", response: DiracAskResponse.APPROVE,
			text: "allow-filesystem-mutate", value: "allow-filesystem-mutate",
		})
		assert.equal(taskState.pendingCardInteractions.get("command-card")?.response?.commandApprovalChoiceId, undefined)
	})

	it("ignores a cancelled interaction even before waiter cleanup runs", async () => {
		const taskState = waitingState("card")
		const controller = new AbortController()
		taskState.pendingCardInteractions.set("card", { signal: controller.signal })
		controller.abort()
		await assert.rejects(submitCardResponse({ taskState }, { cardId: "card", response: DiracAskResponse.APPROVE }), /no pending interaction/)
		assert.equal(taskState.pendingCardInteractions.get("card")?.response, undefined)
		assert.equal(taskState.askResponse, undefined)
	})
})
