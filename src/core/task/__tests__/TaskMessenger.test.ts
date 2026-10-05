import { strict as assert } from "node:assert"
import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "mocha"
import pWaitFor from "p-wait-for"
import sinon from "sinon"
import { TaskMessenger } from "../TaskMessenger"
import { TaskState } from "../TaskState"
import { submitCardResponse } from "../TaskUserInput"
import { ToolSkippedByUserMessage } from "../tools/types/ToolSkippedByUserMessage"

function createMessenger(postStateToWebview = sinon.stub().resolves()) {
	const messages: any[] = []
	const messageStateHandler = {
		addToDiracMessages: sinon.stub().callsFake(async (message) => {
			messages.push(message)
		}),
		findMessageIndexById: sinon.stub().callsFake((id: string) => messages.findIndex((message) => message.id === id)),
		findMessageIndexByCardId: sinon
			.stub()
			.callsFake((id: string) =>
				messages.findIndex((message) => message.content.type === DiracMessageType.CARD && message.content.card.id === id),
			),
		getDiracMessages: sinon.stub().callsFake(() => messages),
		updateDiracMessage: sinon.stub().resolves(),
		appendMarkdownById: sinon.stub().callsFake(async (id: string, text: string) => {
			const message = messages.find((candidate) => candidate.id === id)
			if (!message || message.content.type !== DiracMessageType.MARKDOWN) throw new Error(`Markdown ${id} not found`)
			message.content.content += text
		}),
		patchMarkdownById: sinon.stub().callsFake(async (id: string, patch: Record<string, unknown>) => {
			const message = messages.find((candidate) => candidate.id === id)
			if (!message || message.content.type !== DiracMessageType.MARKDOWN) throw new Error(`Markdown ${id} not found`)
			Object.assign(message.content, patch)
		}),
		patchApiStatusById: sinon.stub().callsFake(async (id: string, patch: Record<string, unknown>) => {
			const message = messages.find((candidate) => candidate.id === id)
			if (!message || message.content.type !== DiracMessageType.API_STATUS) throw new Error(`API status ${id} not found`)
			Object.assign(message.content.status, patch)
		}),
		appendCardBodyById: sinon.stub().callsFake(async (id: string, text: string) => {
			const message = messages.find(
				(candidate) => candidate.content.type === DiracMessageType.CARD && candidate.content.card.id === id,
			)
			if (!message) throw new Error(`Card with id ${id} not found`)
			message.content.card.body = `${message.content.card.body ?? ""}${text}`
		}),
		patchCardById: sinon.stub().callsFake(async (id: string, patch: Record<string, unknown>) => {
			const message = messages.find(
				(candidate) => candidate.content.type === DiracMessageType.CARD && candidate.content.card.id === id,
			)
			if (!message) throw new Error(`Card with id ${id} not found`)
			Object.assign(message.content.card, patch)
			return message.content.card
		}),
		updateCardById: sinon.stub().callsFake(async (id: string, update: (card: any) => any) => {
			const message = messages.find(
				(candidate) => candidate.content.type === DiracMessageType.CARD && candidate.content.card.id === id,
			)
			if (!message) throw new Error(`Card with id ${id} not found`)
			message.content.card = update(structuredClone(message.content.card))
			return structuredClone(message.content.card)
		}),
		flushPendingWrites: sinon.stub().resolves(),
		publishCardInteractionReady: sinon.stub(),
	}
	const taskState = new TaskState()
	const messenger = new TaskMessenger({
		taskState,
		messageStateHandler,
		postStateToWebview,
		getWorkingConfiguration: () => ({ settings: { hooksEnabled: false }, apiConfiguration: {} }) as any,
		taskId: "task-1",
		getCurrentProviderInfo: sinon.stub(),
	} as any)
	return { messenger, messages, taskState, messageStateHandler, postStateToWebview }
}

async function withInteractionTimeout<T>(taskState: TaskState, interaction: Promise<T>): Promise<T> {
	const timer = setTimeout(() => {
		taskState.abort = true
	}, 1500)
	try {
		return await interaction
	} finally {
		clearTimeout(timer)
	}
}

const responseFields = [
	"askResponse",
	"askResponseCardId",
	"askResponseText",
	"askResponseImages",
	"askResponseFiles",
	"askResponseUserEdits",
	"askResponseAction",
	"askResponseValue",
] as const

describe("TaskMessenger text authorship", () => {
	it("defaults non-user text to assistant", async () => {
		const { messenger, messages } = createMessenger()

		await messenger.upsertText("Model update")

		assert.equal(messages[0].content.type, DiracMessageType.MARKDOWN)
		assert.equal(messages[0].content.role, "assistant")
	})

	it("marks model streams as assistant-authored", async () => {
		const { messenger, messages } = createMessenger()

		await messenger.streamText("markdown")

		assert.equal(messages[0].content.type, DiracMessageType.MARKDOWN)
		assert.equal(messages[0].content.role, "assistant")
	})

	it("preserves explicit user authorship", async () => {
		const { messenger, messages } = createMessenger()

		await messenger.upsertText("User guidance", false, undefined, undefined, "user")

		assert.equal(messages[0].content.type, DiracMessageType.MARKDOWN)
		assert.equal(messages[0].content.role, "user")
	})

	it("collapses approval cards when they reach a final status", async () => {
		const { messenger, messages, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({
			header: "Execute: git add .",
			requireApproval: true,
			collapsed: false,
		})

		await card.finalize(CardStatus.CANCELLED)

		assert.equal(messages[0].content.card.status, CardStatus.CANCELLED)
		assert.equal(messages[0].content.card.collapsed, true)
		sinon.assert.calledOnce(messageStateHandler.flushPendingWrites)
	})

	it("persists complete card identity and timestamps terminal cards created in place", async () => {
		const { messenger, messages } = createMessenger()

		const handle = await messenger.createCard({
			header: "Tool Error",
			toolName: "execute_command",
			autoScroll: true,
			status: CardStatus.ERROR,
		})

		assert.equal(handle.getCard().toolName, "execute_command")
		assert.equal(messages[0].content.card.autoScroll, true)
		assert.equal(messages[0].content.card.status, CardStatus.ERROR)
		assert.equal(messages[0].content.card.endTime, messages[0].content.card.startTime)
	})

	it("does not register an interaction until the card actually waits", async () => {
		const { messenger, taskState } = createMessenger()
		await messenger.createCard({ header: "Private question", requireFeedback: true })

		assert.deepEqual(taskState.waitingCardIds, [])
	})

	it("settles and unregisters a pending wait when its card becomes terminal", async () => {
		const { messenger, taskState } = createMessenger()
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })
		const interaction = card.waitForInteraction()
		await pWaitFor(() => taskState.waitingCardIds.includes(card.id))

		await card.update({ status: CardStatus.CANCELLED })

		await assert.rejects(interaction, /became terminal while waiting for interaction/)
		assert.deepEqual(taskState.waitingCardIds, [])
		assert.equal(card.getCard().endTime !== undefined, true)
	})

	it("services concurrent card waits in FIFO order", async () => {
		const { messenger, taskState } = createMessenger()
		const first = await messenger.createCard({ header: "First", requireApproval: true })
		const second = await messenger.createCard({ header: "Second", requireApproval: true })
		const firstInteraction = first.waitForInteraction()
		const secondInteraction = second.waitForInteraction()
		await pWaitFor(() => taskState.waitingCardIds.length === 2 && taskState.status === TaskStatus.AWAITING_USER_INPUT)

		assert.equal(taskState.lastWaitingCardId, first.id)
		taskState.askResponse = DiracAskResponse.APPROVE
		await firstInteraction
		await pWaitFor(() => taskState.lastWaitingCardId === second.id && taskState.status === TaskStatus.AWAITING_USER_INPUT)

		taskState.askResponse = DiracAskResponse.REJECT
		const secondResult = await secondInteraction
		assert.equal(secondResult.response, DiracAskResponse.REJECT)
		assert.deepEqual(taskState.waitingCardIds, [])
	})

	for (const stage of ["persistence", "presentation"]) {
		for (const response of [DiracAskResponse.APPROVE, DiracAskResponse.REJECT]) {
			for (const explicitCardId of [true, false]) {
				it(`keeps an immediate ${response} during ${stage} ${explicitCardId ? "with" : "without"} a card ID`, async () => {
					let answered = false
					const answer = async () => {
						const cardId = taskState.lastWaitingCardId
						if (!cardId || answered) return
						answered = true
						await submitCardResponse(
							{ taskState },
							{
								cardId: explicitCardId ? cardId : "",
								response,
								images: ["preview.png"],
								files: ["notes.txt"],
								value: "selected-option",
							},
						)
					}
					const publication = sinon.stub().callsFake(stage === "presentation" ? answer : async () => {})
					const { messenger, taskState, messageStateHandler } = createMessenger(publication)
					if (stage === "persistence") messageStateHandler.flushPendingWrites.callsFake(answer)
					const card = await messenger.createCard({ header: "Permission", requireApproval: true })

					const result = await withInteractionTimeout(taskState, card.waitForInteraction())

					assert.equal(answered, true)
					assert.equal(result.response, response)
					assert.equal(result.action, response)
					assert.equal(result.value, "selected-option")
					assert.deepEqual(result.images, ["preview.png"])
					assert.deepEqual(result.files, ["notes.txt"])
					assert.deepEqual(taskState.waitingCardIds, [])
					assert.equal(taskState.status, TaskStatus.IDLE)
					for (const field of responseFields) assert.equal(taskState[field], undefined, field)
				})
			}
		}
	}

	it("keeps an immediate chat message and its attachments while setting up the wait", async () => {
		let answered = false
		const publication = sinon.stub().callsFake(async () => {
			const cardId = taskState.lastWaitingCardId
			if (!cardId || answered) return
			answered = true
			await submitCardResponse(
				{ taskState },
				{
					cardId,
					response: DiracAskResponse.MESSAGE,
					text: "Use another command",
					images: ["preview.png"],
					files: ["notes.txt"],
				},
			)
		})
		const { messenger, taskState, messages } = createMessenger(publication)
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })

		await assert.rejects(withInteractionTimeout(taskState, card.waitForInteraction()), ToolSkippedByUserMessage)

		assert.equal(answered, true)
		assert.deepEqual(taskState.waitingCardIds, [])
		assert.equal(taskState.didRejectTool, true)
		assert.equal(messages.at(-1).content.role, "user")
		assert.equal(messages.at(-1).content.content, "Use another command")
		assert.deepEqual(messages.at(-1).content.images, ["preview.png"])
		assert.deepEqual(messages.at(-1).content.files, ["notes.txt"])
		for (const field of responseFields) assert.equal(taskState[field], undefined, field)
	})

	it("clears an early response when the card becomes terminal during setup", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })
		let answered = false
		messageStateHandler.flushPendingWrites.callsFake(async () => {
			if (answered) return
			answered = true
			await submitCardResponse({ taskState }, { cardId: card.id, response: DiracAskResponse.APPROVE, value: "early" })
			await card.update({ status: CardStatus.CANCELLED })
		})

		await assert.rejects(withInteractionTimeout(taskState, card.waitForInteraction()), /became terminal/)

		assert.deepEqual(taskState.waitingCardIds, [])
		sinon.assert.notCalled(messageStateHandler.publishCardInteractionReady)
		for (const field of responseFields) assert.equal(taskState[field], undefined, field)
	})

	it("discards all response fields belonging to another card", async () => {
		const { messenger, taskState } = createMessenger()
		Object.assign(taskState, {
			askResponse: DiracAskResponse.APPROVE,
			askResponseCardId: "earlier-card",
			askResponseText: "stale text",
			askResponseImages: ["stale.png"],
			askResponseFiles: ["stale.txt"],
			askResponseUserEdits: { "stale.txt": "edited" },
			askResponseAction: DiracAskResponse.APPROVE,
			askResponseValue: "stale-value",
		})
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })
		const interaction = withInteractionTimeout(taskState, card.waitForInteraction())
		await pWaitFor(() => taskState.status === TaskStatus.AWAITING_USER_INPUT)

		for (const field of responseFields) assert.equal(taskState[field], undefined, field)
		await submitCardResponse({ taskState }, { cardId: card.id, response: DiracAskResponse.REJECT })
		const result = await interaction
		assert.equal(result.response, DiracAskResponse.REJECT)
		assert.equal(result.value, undefined)
	})

	it("keeps an immediate response during FIFO handoff without clearing the active response", async () => {
		const answered = new Set<string>()
		const publication = sinon.stub().callsFake(async () => {
			const cardId = taskState.lastWaitingCardId
			if (!cardId || answered.has(cardId)) return
			answered.add(cardId)
			await submitCardResponse(
				{ taskState },
				{ cardId, response: answered.size === 1 ? DiracAskResponse.APPROVE : DiracAskResponse.REJECT },
			)
		})
		const { messenger, taskState } = createMessenger(publication)
		const first = await messenger.createCard({ header: "First", requireApproval: true })
		const second = await messenger.createCard({ header: "Second", requireApproval: true })

		const [firstResult, secondResult] = await withInteractionTimeout(
			taskState,
			Promise.all([first.waitForInteraction(), second.waitForInteraction()]),
		)

		assert.equal(firstResult.response, DiracAskResponse.APPROVE)
		assert.equal(secondResult.response, DiracAskResponse.REJECT)
		assert.deepEqual([...answered], [first.id, second.id])
		assert.deepEqual(taskState.waitingCardIds, [])
		for (const field of responseFields) assert.equal(taskState[field], undefined, field)
	})

	it("lets a queued live approval resolve without taking over the active interaction", async () => {
		const { messenger, taskState } = createMessenger()
		let autoApproveSecond = false
		const first = await messenger.createCard({ header: "First", requireApproval: true })
		const second = await messenger.createCard({
			header: "Second",
			requireApproval: true,
			isAutoApproved: () => autoApproveSecond,
		})
		const firstInteraction = first.waitForInteraction()
		const secondInteraction = second.waitForInteraction()
		await pWaitFor(() => taskState.waitingCardIds.length === 2 && taskState.status === TaskStatus.AWAITING_USER_INPUT)

		autoApproveSecond = true
		const secondResult = await secondInteraction

		assert.equal(secondResult.response, DiracAskResponse.APPROVE)
		assert.equal(taskState.lastWaitingCardId, first.id)
		assert.equal(taskState.status, TaskStatus.AWAITING_USER_INPUT)

		taskState.askResponse = DiracAskResponse.APPROVE
		await firstInteraction
		assert.deepEqual(taskState.waitingCardIds, [])
	})

	it("does not block card lifecycle operations on state delivery", async () => {
		const postStateToWebview = sinon.stub().returns(new Promise<void>(() => {}))
		const { messenger, messages, messageStateHandler } = createMessenger(postStateToWebview)

		const card = await messenger.createCard({ header: "Long-running publication" })
		await card.update({ body: "updated" })
		await card.finalize(CardStatus.SUCCESS)

		assert.equal(messages[0].content.card.body, "updated")
		assert.equal(messages[0].content.card.status, CardStatus.SUCCESS)
		sinon.assert.calledOnce(messageStateHandler.flushPendingWrites)
		assert.equal(postStateToWebview.callCount, 3)
	})

	it("accepts a chat message while awaiting card input and clears the wait", async () => {
		const { messenger, messages, taskState, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({
			header: "Proposed Plan",
			requireFeedback: true,
			collapsed: false,
		})

		const interaction = card.waitForInteraction()
		await pWaitFor(() => taskState.status === TaskStatus.AWAITING_USER_INPUT)
		sinon.assert.calledOnce(messageStateHandler.flushPendingWrites)
		taskState.askResponse = DiracAskResponse.MESSAGE
		taskState.askResponseText = "Revise step two"

		await assert.rejects(interaction, ToolSkippedByUserMessage)

		assert.deepEqual(taskState.waitingCardIds, [])
		assert.equal(messages.at(-1).content.type, DiracMessageType.MARKDOWN)
		assert.equal(messages.at(-1).content.role, "user")
		assert.equal(messages.at(-1).content.content, "Revise step two")
	})

	it("treats an attachment-only chat response as skipping pending input", async () => {
		const { messenger, taskState } = createMessenger()
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })

		const interaction = card.waitForInteraction()
		await pWaitFor(() => taskState.status === TaskStatus.AWAITING_USER_INPUT)
		taskState.askResponse = DiracAskResponse.MESSAGE
		taskState.askResponseFiles = ["notes.txt"]

		await assert.rejects(interaction, ToolSkippedByUserMessage)
		assert.deepEqual(taskState.waitingCardIds, [])
	})

	it("resolves a waiting tool permission when live auto-approval is enabled", async () => {
		const { messenger, taskState } = createMessenger()
		let autoApprove = false
		const card = await messenger.createCard({
			header: "Permission",
			requireApproval: true,
			isAutoApproved: () => autoApprove,
		})

		const interaction = card.waitForInteraction()
		await pWaitFor(() => taskState.status === TaskStatus.AWAITING_USER_INPUT)
		autoApprove = true

		const result = await interaction
		assert.equal(result.response, DiracAskResponse.APPROVE)
		assert.equal(result.action, DiracAskResponse.APPROVE)
		assert.equal(result.value, DiracAskResponse.APPROVE)
		assert.equal(typeof result.askTs, "number")
		assert.deepEqual(taskState.waitingCardIds, [])
	})
})
