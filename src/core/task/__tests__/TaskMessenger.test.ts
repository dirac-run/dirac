import { strict as assert } from "node:assert"
import { CardKind, CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "mocha"
import pWaitFor from "p-wait-for"
import sinon from "sinon"
import { TaskMessenger, TaskletEscalationCleanupError } from "../TaskMessenger"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { TaskState } from "../TaskState"
import { submitCardResponse } from "../TaskUserInput"
import { ToolSkippedByUserMessage } from "../tools/types/ToolSkippedByUserMessage"
import type { TaskCounterparty, TaskInteractionRequest } from "../types/task-messenger"

function createMessenger(postStateToWebview = sinon.stub().resolves(), counterparty?: TaskCounterparty) {
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
		counterparty,
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

describe("TaskMessenger communication projection", () => {
	it("updates one observational card across the child card lifecycle", async () => {
		const root = createMessenger()
		const child = createMessenger(sinon.stub().resolves(), {
			recordResponse: sinon.stub().resolves(),
			requestInteraction: sinon.stub().resolves(),
			publishCommunicationCard: (card) => root.messenger.upsertCommunicationCard("Feynman", card),
		})
		const handle = await child.messenger.createCard({
			header: "Feynman is sending a message to Planck",
			body: "Actual message",
			communication: { actor: "Feynman" },
			rawInput: { privateInput: true },
			requireFeedback: true,
			actions: [{ label: "Reply", value: "reply" }],
		})
		await handle.appendBody(" content")
		await handle.update({ header: "Feynman sent a message to Planck" })
		await handle.finalize(CardStatus.SUCCESS)
		assert.equal(root.messages.length, 1)
		const projected = root.messages[0].content.card
		assert.equal(projected.id, `Feynman:${handle.id}`)
		assert.equal(projected.body, "Actual message content")
		assert.equal(projected.status, CardStatus.SUCCESS)
		assert.equal(projected.header, "Feynman sent a message to Planck")
		assert.equal(projected.communication.actor, "Feynman")
		assert.equal(projected.requireFeedback, undefined)
		assert.equal(projected.actions, undefined)
		assert.equal(projected.rawInput, undefined)
		assert.deepEqual(root.taskState.waitingCardIds, [])
		assert.equal(child.messages.length, 1)
	})

	it("does not forward unrelated tool cards", async () => {
		const publishCommunicationCard = sinon.stub().resolves()
		const child = createMessenger(sinon.stub().resolves(), {
			recordResponse: sinon.stub().resolves(),
			requestInteraction: sinon.stub().resolves(),
			publishCommunicationCard,
		})
		const card = await child.messenger.createCard({ header: "Read file", body: "contents" })
		await card.finalize(CardStatus.SUCCESS)
		sinon.assert.notCalled(publishCommunicationCard)
	})

	it("deduplicates concurrent snapshots and namespaces sibling card IDs", async () => {
		const { messenger, messages } = createMessenger()
		const card = {
			id: "same-id", kind: CardKind.GENERIC, header: "Message", body: "content",
			renderType: "text" as const,
			status: CardStatus.SUCCESS, communication: { actor: "untrusted" },
		}
		await Promise.all([
			messenger.upsertCommunicationCard("Feynman", card),
			messenger.upsertCommunicationCard("Feynman", card),
			messenger.upsertCommunicationCard("Planck", card),
		])
		assert.equal(messages.length, 2)
		assert.deepEqual(messages.map((message) => message.content.card.communication.actor), ["Feynman", "Planck"])
	})

	it("surfaces publication failures instead of dropping communication silently", async () => {
		const failure = new Error("publication failed")
		const child = createMessenger(sinon.stub().resolves(), {
			recordResponse: sinon.stub().resolves(),
			requestInteraction: sinon.stub().resolves(),
			publishCommunicationCard: sinon.stub().rejects(failure),
		})
		await assert.rejects(child.messenger.createCard({
			header: "Message", communication: { actor: "Feynman" },
		}), (error) => error === failure)
	})
})

describe("TaskMessenger tasklet escalation", () => {
	const child = { id: "tasklet-private", title: "Private worker" }
	function request(): TaskInteractionRequest {
		return {
			card: {
				id: "private-card",
				kind: CardKind.GENERIC,
				header: "Execute?",
				body: "Full operation",
				status: CardStatus.WAITING_FOR_INPUT,
				renderType: "text",
				requireApproval: true,
				startTime: 1,
				rawInput: { commands: ["echo example"] },
				actions: [{ label: "Approve", value: DiracAskResponse.APPROVE, primary: true }],
			},
			permissionOperation: { kind: "commands", commands: ["echo example"] },
		}
	}

	it("copies full operation details into a fresh card and accepts an immediate response", async () => {
		const { messenger, messages, taskState, messageStateHandler } = createMessenger()
		messageStateHandler.flushPendingWrites.callsFake(async () => {
			const cardId = taskState.lastWaitingCardId
			if (cardId) submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.APPROVE })
		})
		const input = request()
		const result = await messenger.escalateTaskletInteraction(child, input, new AbortController().signal)
		const card = messages[0].content.card
		assert.equal(result.action, DiracAskResponse.APPROVE)
		assert.notEqual(card.id, input.card.id)
		assert.notEqual(card.startTime, 1)
		assert.match(card.header, /tasklet-private requested your approval.*Execute/)
		assert.deepEqual(card.rawInput, input.card.rawInput)
		assert.deepEqual(card.actions, input.card.actions)
		assert.equal(card.approvalScope, "once")
		assert.equal(input.card.approvalScope, undefined)
		assert.equal(card.status, CardStatus.SUCCESS)
		assert.equal(input.card.status, CardStatus.WAITING_FOR_INPUT)
		assert.deepEqual(taskState.waitingCardIds, [])
	})

	it("does not create a card for pre-aborted or owner-routed escalation", async () => {
		const { messenger, messages } = createMessenger()
		const controller = new AbortController()
		controller.abort(new Error("retired"))
		await assert.rejects(messenger.escalateTaskletInteraction(child, request(), controller.signal), /retired/)
		assert.deepEqual(messages, [])
		const owner = createMessenger(undefined, { recordResponse: async () => { }, requestInteraction: sinon.stub() })
		await assert.rejects(
			owner.messenger.escalateTaskletInteraction(child, request(), new AbortController().signal),
			/root messenger/,
		)
		assert.deepEqual(owner.messages, [])
	})

	it("cancels a card created after its child retired", async () => {
		const { messenger, messages, taskState, messageStateHandler } = createMessenger()
		let release!: () => void
		messageStateHandler.addToDiracMessages.callsFake(async (message) => {
			messages.push(message)
			await new Promise<void>((resolve) => {
				release = resolve
			})
		})
		const controller = new AbortController()
		const rejected = assert.rejects(messenger.escalateTaskletInteraction(child, request(), controller.signal), /retired/)
		controller.abort(new Error("retired"))
		release()
		await rejected
		assert.equal(messages[0].content.card.status, CardStatus.CANCELLED)
		assert.deepEqual(taskState.waitingCardIds, [])
		sinon.assert.notCalled(messageStateHandler.publishCardInteractionReady)
	})

	it("cancels queued escalation without consuming the active root response", async () => {
		const { messenger, messages, taskState } = createMessenger()
		const foreground = await messenger.createCard({ header: "Root question", requireFeedback: true })
		const foregroundWait = foreground.waitForInteraction()
		await pWaitFor(() => taskState.status === TaskStatus.AWAITING_USER_INPUT, { interval: 1 })
		const controller = new AbortController()
		const rejected = assert.rejects(messenger.escalateTaskletInteraction(child, request(), controller.signal), /abort/i)
		await pWaitFor(() => taskState.waitingCardIds.length === 2, { interval: 1 })
		submitCardResponse({ taskState }, { cardId: foreground.id, response: DiracAskResponse.REJECT })
		controller.abort()
		await rejected
		assert.equal((await foregroundWait).action, DiracAskResponse.REJECT)
		assert.equal(messages[1].content.card.status, CardStatus.CANCELLED)
		assert.deepEqual(taskState.waitingCardIds, [])
	})

	for (const queued of [false, true]) {
		it(`settles ${queued ? "queued" : "active"} cancellation when terminal patch fails`, async () => {
			const { messenger, messages, taskState, messageStateHandler } = createMessenger()
			const foreground = queued ? await messenger.createCard({ header: "Root question", requireFeedback: true }) : undefined
			const foregroundWait = foreground?.waitForInteraction()
			if (foreground) await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
			const controller = new AbortController()
			const failure = new Error("terminal patch failed")
			const waiting = messenger.escalateTaskletInteraction(child, request(), controller.signal)
			const rejected = assert.rejects(withInteractionTimeout(taskState, waiting), (error: unknown) => {
				assert.ok(error instanceof TaskletEscalationCleanupError)
				assert.equal(error.cause, failure)
				return true
			})
			await pWaitFor(
				() =>
					queued ? taskState.waitingCardIds.length === 2 : messageStateHandler.publishCardInteractionReady.calledOnce,
				{ interval: 1 },
			)
			messageStateHandler.patchCardById.rejects(failure)
			controller.abort(new Error("child retired"))
			await rejected
			assert.equal(taskState.abort, false, "must settle without timeout/root abort")
			assert.equal(messages.at(-1).content.card.status, CardStatus.WAITING_FOR_INPUT)
			assert.deepEqual(taskState.waitingCardIds, foreground ? [foreground.id] : [])
			for (const field of responseFields) assert.equal(taskState[field], undefined)
			if (foreground) {
				submitCardResponse({ taskState }, { cardId: foreground.id, response: DiracAskResponse.REJECT })
				assert.equal((await foregroundWait)!.action, DiracAskResponse.REJECT)
			}
		})
	}

	it("reports failed publication after clearing the cancelled escalation FIFO", async () => {
		expectLoggerErrors()
		const { messenger, taskState, messageStateHandler, postStateToWebview } = createMessenger()
		const controller = new AbortController()
		const failure = new Error("publication failed")
		const rejected = assert.rejects(
			messenger.escalateTaskletInteraction(child, request(), controller.signal),
			(error: unknown) => {
				assert.ok(error instanceof TaskletEscalationCleanupError)
				assert.equal(error.cause, failure)
				return true
			},
		)
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
		postStateToWebview.rejects(failure)
		controller.abort()
		await rejected
		assert.deepEqual(taskState.waitingCardIds, [])
		for (const field of responseFields) assert.equal(taskState[field], undefined)
	})

	it("reports admission failure even when a card was retained before rejection", async () => {
		const { messenger, messages, messageStateHandler } = createMessenger()
		const failure = new Error("admission persistence failed")
		messageStateHandler.addToDiracMessages.callsFake(async (message) => {
			messages.push(message)
			throw failure
		})
		await assert.rejects(
			messenger.escalateTaskletInteraction(child, request(), new AbortController().signal),
			(error: unknown) => {
				assert.ok(error instanceof TaskletEscalationCleanupError)
				assert.equal(error.cause, failure)
				return true
			},
		)
		assert.equal(messages.length, 1)
	})

	for (const source of ["child", "root"] as const) {
		it(`cancels an active escalation on ${source} abort`, async () => {
			const { messenger, messages, taskState, messageStateHandler } = createMessenger()
			const controller = new AbortController()
			const rejected = assert.rejects(messenger.escalateTaskletInteraction(child, request(), controller.signal))
			await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
			if (source === "child") controller.abort()
			else taskState.abort = true
			await rejected
			assert.equal(messages[0].content.card.status, CardStatus.CANCELLED)
			assert.deepEqual(taskState.waitingCardIds, [])
		})
	}

	it("preserves ordinary option values without treating them as permissions", async () => {
		const { messenger, messages, taskState, messageStateHandler } = createMessenger()
		const input = request()
		delete input.permissionOperation
		input.card = { ...input.card, requireApproval: false, requireFeedback: true }
		messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) => {
			submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.APPROVE, value: "Retry" })
		})
		const result = await messenger.escalateTaskletInteraction(child, input, new AbortController().signal)
		assert.equal(result.value, "Retry")
		assert.equal(messages[0].content.card.status, CardStatus.SUCCESS)
	})

	it("rejects operation-changing permission edits and closes the card", async () => {
		const { messenger, messages, taskState, messageStateHandler } = createMessenger()
		messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) => {
			submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.APPROVE })
			taskState.askResponseUserEdits = { "file.ts": "changed" }
		})
		await assert.rejects(
			messenger.escalateTaskletInteraction(child, request(), new AbortController().signal),
			/cannot change/,
		)
		assert.equal(messages[0].content.card.status, CardStatus.CANCELLED)
	})

	it("keeps normal chat interruption an exception, not an approval", async () => {
		const { messenger, messages, taskState, messageStateHandler } = createMessenger()
		messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) => {
			submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.MESSAGE, text: "Stop and reconsider" })
		})
		await assert.rejects(
			messenger.escalateTaskletInteraction(child, request(), new AbortController().signal),
			ToolSkippedByUserMessage,
		)
		assert.equal(messages[0].content.card.status, CardStatus.CANCELLED)
		assert.deepEqual(taskState.waitingCardIds, [])
	})
})

describe("TaskMessenger owner interactions", () => {
	function owner() {
		return {
			recordResponse: sinon.stub().resolves(),
			requestInteraction: sinon.stub().callsFake(
				(_request, signal: AbortSignal) =>
					new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true })
					}),
			),
		}
	}

	it("flushes before owner registration and bypasses live approval, foreground FIFO and notifications", async () => {
		const counterparty = owner()
		const { messenger, taskState, messageStateHandler } = createMessenger(undefined, counterparty)
		const notification = sinon.stub(messenger, "runNotificationHook").resolves()
		const autoApprove = sinon.stub().returns(true)
		let release!: () => void
		messageStateHandler.flushPendingWrites.callsFake(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const card = await messenger.createCard({ header: "Permission", requireApproval: true, isAutoApproved: autoApprove })
		const waiting = card.waitForInteraction()
		const rejected = assert.rejects(waiting)
		sinon.assert.notCalled(counterparty.requestInteraction)
		assert.equal(taskState.status, TaskStatus.AWAITING_USER_INPUT)
		release()
		await pWaitFor(() => counterparty.requestInteraction.calledOnce, { interval: 1 })
		assert.deepEqual(taskState.waitingCardIds, [])
		sinon.assert.notCalled(autoApprove)
		sinon.assert.notCalled(notification)
		sinon.assert.notCalled(messageStateHandler.publishCardInteractionReady)
		taskState.abort = true
		await rejected
	})

	it("forwards the trusted operation descriptor and prior Utility escalation to its owner", async () => {
		const counterparty = {
			recordResponse: sinon.stub().resolves(),
			requestInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT }),
		}
		const { messenger } = createMessenger(undefined, counterparty)
		const operation = { kind: "commands" as const, commands: ["exact normalized command"] }
		const card = await messenger.createCard({
			header: "Permission", requireApproval: true, permissionOperation: operation,
			utilityPermissionEscalation: "Policy does not cover this command",
		})
		await card.waitForInteraction()
		assert.deepEqual(counterparty.requestInteraction.firstCall.args[0].permissionOperation, operation)
		assert.equal(counterparty.requestInteraction.firstCall.args[0].utilityPermissionEscalation, "Policy does not cover this command")
	})

	it("does not register a request aborted during its transcript flush", async () => {
		const counterparty = owner()
		const { messenger, taskState, messageStateHandler } = createMessenger(undefined, counterparty)
		let release!: () => void
		messageStateHandler.flushPendingWrites.callsFake(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const card = await messenger.createCard({ header: "Question", requireFeedback: true })
		const rejected = assert.rejects(card.waitForInteraction())
		taskState.abort = true
		release()
		await rejected
		sinon.assert.notCalled(counterparty.requestInteraction)
	})

	it("retires terminal-card waits independently and restores status only after the last owner wait", async () => {
		const counterparty = owner()
		const { messenger, taskState } = createMessenger(undefined, counterparty)
		taskState.status = TaskStatus.WAITING_FOR_API
		const first = await messenger.createCard({ header: "First", requireFeedback: true })
		const second = await messenger.createCard({ header: "Second", requireFeedback: true })
		const firstRejected = assert.rejects(first.waitForInteraction(), /became terminal/)
		const secondRejected = assert.rejects(second.waitForInteraction(), /became terminal/)
		await pWaitFor(() => counterparty.requestInteraction.calledTwice, { interval: 1 })
		await first.finalize(CardStatus.CANCELLED)
		await firstRejected
		assert.equal(taskState.status, TaskStatus.AWAITING_USER_INPUT)
		assert.equal(counterparty.requestInteraction.secondCall.args[1].aborted, false)
		await second.finalize(CardStatus.CANCELLED)
		await secondRejected
		assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
	})
})

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

	it("architecture display uses real chat input/cancellation and persists navigation without opening a panel", async () => {
		const { create } = await import("../tools/modules/architecture_diagram/tool")
		const { CardHandle } = await import("../tools/adapters/CardHandle")
		for (const cancel of [false, true]) {
			const { messenger, taskState, messages, messageStateHandler } = createMessenger()
			const operation = create().processCall(
				{ operation: "display_diagram", name: "tools" },
				{
					ui: { createCard: async (params) => new CardHandle(await messenger.createCard(params)) },
					architecture: {
						openDisplay: async (selection) => ({
							available: true,
							waitForInput: true,
							selection: { ...selection, taskId: "owner" },
						}),
					} as import("../tools/interfaces/IArchitectureTrait").IArchitectureTrait,
				},
			)
			const settled = assert.rejects(operation, cancel ? /aborted/ : ToolSkippedByUserMessage)
			await pWaitFor(() => taskState.status === TaskStatus.AWAITING_USER_INPUT, { timeout: 1500 })
			assert.ok(messageStateHandler.flushPendingWrites.called)
			assert.equal(messages[0].content.card.architectureReference.mode, "latest")
			if (cancel) taskState.abort = true
			else
				await submitCardResponse(
					{ taskState },
					{ cardId: "", response: DiracAskResponse.MESSAGE, text: "Keep the boundary", images: [], files: [] },
				)
			await settled
			assert.equal(messages[0].content.card.status, cancel ? CardStatus.CANCELLED : CardStatus.SKIPPED)
			assert.equal(messages[0].content.card.architectureReference.taskId, "owner")
			assert.deepEqual(taskState.waitingCardIds, [])
			if (!cancel) assert.equal(messages[1].content.content, "Keep the boundary")
		}
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
			for (const explicitCardId of [true]) {
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
					const publication = sinon.stub().callsFake(stage === "presentation" ? answer : async () => { })
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
		const postStateToWebview = sinon.stub().returns(new Promise<void>(() => { }))
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
