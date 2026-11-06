import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { TaskState } from "../TaskState"
import { submitCardResponse } from "../TaskUserInput"

describe("TaskUserInput addressed card actions", () => {
	for (const response of [DiracAskResponse.APPROVE, DiracAskResponse.REJECT, "custom_action"]) {
		it(`does not route an empty-card ${response} to the foreground waiter`, async () => {
			const taskState = new TaskState()
			taskState.waitingCardIds = ["foreground-card"]

			await submitCardResponse({ taskState }, { cardId: "", response })

			assert.equal(taskState.askResponse, undefined)
			assert.equal(taskState.askResponseAction, undefined)
			assert.equal(taskState.askResponseCardId, undefined)
		})
	}

	it("ignores a retired card instead of answering the new request", async () => {
		const taskState = new TaskState()
		taskState.waitingCardIds = ["new-card"]

		await submitCardResponse({ taskState }, { cardId: "retired-card", response: DiracAskResponse.APPROVE })

		assert.equal(taskState.askResponse, undefined)
		assert.equal(taskState.askResponseCardId, undefined)
	})

	it("accepts only the identified current request", async () => {
		const taskState = new TaskState()
		taskState.waitingCardIds = ["current-card"]

		await submitCardResponse({ taskState }, { cardId: "current-card", response: DiracAskResponse.REJECT })

		assert.equal(taskState.askResponse, DiracAskResponse.REJECT)
		assert.equal(taskState.askResponseCardId, "current-card")
	})

	it("preserves unaddressed chat as user input rather than approval authority", async () => {
		const taskState = new TaskState()
		taskState.waitingCardIds = ["current-card"]

		await submitCardResponse({ taskState }, { cardId: "", response: DiracAskResponse.MESSAGE, text: "approved" })

		assert.equal(taskState.askResponse, DiracAskResponse.MESSAGE)
		assert.equal(taskState.askResponseText, "approved")
		assert.equal(taskState.didRejectTool, true)
	})
})
