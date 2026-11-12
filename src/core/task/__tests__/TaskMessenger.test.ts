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
import type { TaskCounterparty, TaskInteractionRequest, TaskMessengerInvocationContext } from "../types/task-messenger"
import * as hookExecutor from "@core/hooks/hook-executor"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import { Task } from ".."
import { PlanInteractionResponse, ResponseOperation, responseCardInput } from "@shared/responseTool"
import { modeSwitchNotice } from "@shared/modeSwitch"

function createMessenger(postStateToWebview = sinon.stub().resolves(), counterparty?: TaskCounterparty, hooksEnabled = false) {
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
		getMessageById: sinon.stub().callsFake((id: string) => messages.find((message) => message.id === id)),
		patchMessageById: sinon.stub().callsFake(async (id: string, patch: Record<string, unknown>) => {
			const message = messages.find((candidate) => candidate.id === id)
			if (!message) throw new Error(`Message ${id} not found`)
			Object.assign(message, patch)
		}),
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
	const setActiveHookExecution = sinon.stub().resolves()
	const clearActiveHookExecution = sinon.stub().resolves()
	const messenger = new TaskMessenger({
		taskState,
		messageStateHandler,
		postStateToWebview,
		counterparty,
		getWorkingConfiguration: () => ({ settings: { hooksEnabled }, apiConfiguration: { actModeApiModelId: "test-model" } }) as any,
		setActiveHookExecution,
		clearActiveHookExecution,
		taskId: "task-1",
		getCurrentProviderInfo: sinon.stub(),
	} as any)
	return { messenger, messages, taskState, messageStateHandler, postStateToWebview, setActiveHookExecution, clearActiveHookExecution }
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

function invocationContext(hooksEnabled = false): TaskMessengerInvocationContext {
	return {
		executionId: "origin-execution",
		signal: new AbortController().signal,
		hooksEnabled,
		hookModel: { provider: "anthropic", slug: "origin-model" },
	}
}

function switchMode(taskState: TaskState, previous: "plan" | "act", next: "plan" | "act", content?: { message?: string; images?: string[]; files?: string[] }) {
	const applyCommittedModeEffects = (Task.prototype as any).applyCommittedModeEffects
	applyCommittedModeEffects.call({ taskState }, previous, next, content)
}

describe("TaskMessenger in-place mode switches", () => {
	for (const kind of ["question", "permission"] as const) {
		it(`skips a root ${kind} through the existing user-message path on mode switch`, async () => {
			const { messenger, taskState, messages, messageStateHandler } = createMessenger()
			const card = await messenger.createCard({ header: kind, requireFeedback: kind === "question", requireApproval: kind === "permission" })
			const settled = assert.rejects(card.waitForInteraction(), (error: unknown) => {
				assert.ok(error instanceof ToolSkippedByUserMessage)
				assert.equal(error.userMessage, `${modeSwitchNotice("plan")}\n\nChange direction`)
				assert.deepEqual(error.userImages, ["image"])
				assert.deepEqual(error.userFiles, ["file"])
				return true
			})
			await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })

			switchMode(taskState, "act", "plan", { message: "Change direction", images: ["image"], files: ["file"] })

			await withInteractionTimeout(taskState, settled)
			assert.equal(taskState.abort, false)
			assert.equal(taskState.didRejectTool, false)
			assert.equal(taskState.pendingCardInteractions.size, 0)
			assert.equal(messages.filter((message) => message.content.role === "user").length, 0, "synthetic switch notices must not be echoed as user chat")
		})
	}

	it("approves a Plan card with the mode-toggle value and preserves composer attachments", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({ header: "Proposed Plan", toolName: "respond", rawInput: responseCardInput(ResponseOperation.PLAN, "Plan"), requireFeedback: true })
		const wait = card.waitForInteraction()
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })

		switchMode(taskState, "plan", "act", { message: "Go ahead", images: ["image"], files: ["file"] })

		const result = await withInteractionTimeout(taskState, wait)
		assert.equal(result.response, DiracAskResponse.APPROVE)
		assert.equal(result.action, DiracAskResponse.APPROVE)
		assert.equal(result.value, PlanInteractionResponse.MODE_TOGGLE)
		assert.equal(result.text, "Go ahead")
		assert.deepEqual(result.images, ["image"])
		assert.deepEqual(result.files, ["file"])
	})

	it("settles parallel root waits while delivering accompanying content only once", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const first = await messenger.createCard({ header: "First", requireFeedback: true })
		const second = await messenger.createCard({ header: "Second", requireApproval: true })
		const skipped: ToolSkippedByUserMessage[] = []
		const waits = [first, second].map((card) => assert.rejects(card.waitForInteraction(), (error: unknown) => {
			assert.ok(error instanceof ToolSkippedByUserMessage)
			skipped.push(error)
			return true
		}))
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledTwice, { interval: 1 })

		switchMode(taskState, "act", "plan", { message: "Only once", images: ["image"], files: ["file"] })

		await withInteractionTimeout(taskState, Promise.all(waits))
		assert.equal(skipped.filter((error) => error.userMessage.includes("Only once")).length, 1)
		assert.equal(skipped.filter((error) => error.userImages?.length).length, 1)
		assert.equal(skipped.filter((error) => error.userFiles?.length).length, 1)
		assert.ok(skipped.every((error) => error.userMessage.includes(modeSwitchNotice("plan"))))
		assert.equal(taskState.pendingCardInteractions.size, 0)
	})

	it("keeps the first addressed answer when a mode switch races its consumption", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })
		const wait = card.waitForInteraction()
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
		await submitCardResponse({ taskState }, { cardId: card.id, response: DiracAskResponse.APPROVE, text: "Original answer" })

		switchMode(taskState, "act", "plan", { message: "Later draft" })

		const result = await withInteractionTimeout(taskState, wait)
		assert.equal(result.response, DiracAskResponse.APPROVE)
		assert.equal(result.text, "Original answer")
	})

	it("does not auto-answer an escalated child interaction", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({ header: "Child permission", requireApproval: true, isTaskletInteraction: true })
		const wait = card.waitForInteraction()
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
		const pending = taskState.pendingCardInteractions.get(card.id)!
		assert.equal(pending.modeSwitchResponse, undefined)

		switchMode(taskState, "act", "plan")

		assert.equal(pending.response, undefined)
		assert.deepEqual(taskState.waitingCardIds, [card.id])
		await submitCardResponse({ taskState }, { cardId: card.id, response: DiracAskResponse.REJECT })
		assert.equal((await withInteractionTimeout(taskState, wait)).response, DiracAskResponse.REJECT)
	})
})

describe("TaskMessenger mode switch before wait registration", () => {
	it("settles a root wait registered after the switch without echoing a synthetic user message", async () => {
		const { messenger, taskState, messages } = createMessenger()
		const card = await messenger.createCard({ header: "Late question", requireFeedback: true })
		switchMode(taskState, "act", "plan")

		await withInteractionTimeout(taskState, assert.rejects(card.waitForInteraction(), (error: unknown) => {
			assert.ok(error instanceof ToolSkippedByUserMessage)
			assert.equal(error.modeSwitch, "plan")
			assert.equal(error.userMessage, modeSwitchNotice("plan"))
			return true
		}))

		assert.equal(taskState.pendingCardInteractions.size, 0)
		assert.equal(messages.filter((message) => message.content.role === "user").length, 0)
	})

	it("does not apply an unconsumed switch notice to a late child escalation", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		switchMode(taskState, "act", "plan")
		const card = await messenger.createCard({ header: "Child permission", requireApproval: true, isTaskletInteraction: true })
		const wait = card.waitForInteraction()
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })

		assert.equal(taskState.pendingCardInteractions.get(card.id)!.response, undefined)
		await submitCardResponse({ taskState }, { cardId: card.id, response: DiracAskResponse.REJECT })
		assert.equal((await withInteractionTimeout(taskState, wait)).response, DiracAskResponse.REJECT)
	})
})

describe("TaskMessenger invocation output isolation", () => {
	it("keeps late invocation cards, text, streams and checkpoints off the current model stream", async () => {
		const { messenger, taskState, messages } = createMessenger()
		const scoped = messenger.forInvocation(invocationContext())
		const current = await messenger.streamText("reasoning")
		await current.append("Current model")

		const card = await scoped.createCard({ header: "Late execution", status: CardStatus.SUCCESS })
		await scoped.upsertText("Old reasoning", true)
		const oldStream = await scoped.streamText("markdown")
		await oldStream.append("Old execution text")
		await oldStream.close()
		await scoped.createCheckpoint()
		assert.equal(taskState.activeVoiceStreamId, current.id)
		assert.equal(messages.find((message) => message.id === card.id).content.card.executionId, "origin-execution")
		assert.equal(messages.find((message) => message.id === current.id).content.content, "Current model")
		await current.append(" continues")
		assert.equal(messages.find((message) => message.id === current.id).content.content, "Current model continues")
		await current.close()
		assert.equal(taskState.activeVoiceStreamId, undefined)
	})

	it("preserves the legacy unscoped card stream handoff", async () => {
		const { messenger, taskState } = createMessenger()
		await messenger.streamText("markdown")
		await messenger.createCard({ header: "Legacy card" })
		assert.equal(taskState.activeVoiceStreamId, undefined)
	})

	it("uses originating notification model/settings and scopes nested hook output", async () => {
		const { messenger, taskState, messages, messageStateHandler } = createMessenger()
		const invocation = invocationContext(true)
		const scoped = messenger.forInvocation(invocation)
		const card = await scoped.createCard({ header: "Origin permission", requireApproval: true })
		const current = await messenger.streamText("reasoning")
		await current.append("Current model")
		const execute = sinon.stub(hookExecutor, "executeHook").callsFake(async (options) => {
			assert.deepEqual(options.model, invocation.hookModel)
			assert.equal(options.hooksEnabled, true, "origin settings win even though current hooks are disabled")
			await options.messenger.createCard({ header: "Origin hook", status: CardStatus.SUCCESS })
			await options.messenger.upsertText("Origin hook output", true)
			const hookStream = await options.messenger.streamText("reasoning")
			await hookStream.append("Origin hook stream")
			await hookStream.close()
			await options.messenger.createCheckpoint()
			return {} as any
		})
		try {
			messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) =>
				submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.APPROVE }))
			assert.equal((await withInteractionTimeout(taskState, card.waitForInteraction())).response, DiracAskResponse.APPROVE)
			sinon.assert.calledOnce(execute)
			assert.equal(taskState.activeVoiceStreamId, current.id)
			assert.equal(messages.find((message) => message.content.card?.header === "Origin hook").content.card.executionId, invocation.executionId)
			assert.equal(messages.find((message) => message.id === current.id).content.content, "Current model")
		} finally {
			execute.restore()
			await current.close()
		}
	})

	it("keeps originating hooks disabled after the current settings enable them", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger(undefined, undefined, true)
		const card = await messenger.createCard({ header: "Origin permission", requireApproval: true }, invocationContext(false))
		const execute = sinon.stub(hookExecutor, "executeHook").resolves({} as any)
		try {
			messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) =>
				submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.APPROVE }))
			await withInteractionTimeout(taskState, card.waitForInteraction())
			sinon.assert.notCalled(execute)
		} finally {
			execute.restore()
		}
	})
})

describe("TaskMessenger notification cleanup failures", () => {
	it("propagates hook cleanup failures instead of logging a nonfatal notification error", async () => {
		const { messenger, taskState } = createMessenger()
		const card = await messenger.createCard({ header: "Origin permission", requireApproval: true }, invocationContext(true))
		const failure = new HookCleanupError([new Error("termination failed")], "Hook cleanup failed")
		const execute = sinon.stub(hookExecutor, "executeHook").rejects(failure)
		try {
			await assert.rejects(withInteractionTimeout(taskState, card.waitForInteraction()), (error) => error === failure)
			assert.equal(taskState.pendingCardInteractions.size, 0)
			assert.deepEqual(taskState.waitingCardIds, [])
		} finally {
			execute.restore()
		}
	})
})

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
		assert.equal(projected.collapsed, true)
		assert.equal(projected.do_not_auto_collapse, undefined)
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
		assert.equal(card.header, "tasklet-private · Approved by you")
		assert.deepEqual(card.rawInput, input.card.rawInput)
		assert.deepEqual(card.actions, input.card.actions)
		assert.equal(card.approvalScope, "once")
		assert.equal(input.card.approvalScope, undefined)
		assert.equal(card.status, CardStatus.SUCCESS)
		assert.equal(input.card.status, CardStatus.WAITING_FOR_INPUT)
		assert.deepEqual(taskState.waitingCardIds, [])
	})

	for (const response of [DiracAskResponse.APPROVE, DiracAskResponse.REJECT]) {
		it(`shows actual user ${response} and prior Utility context without changing the operation`, async () => {
			const { messenger, messages, taskState, messageStateHandler } = createMessenger()
			messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) => {
				submitCardResponse({ taskState }, { cardId, response })
			})
			const input = { ...request(), utilityPermissionEscalation: "Policy does not cover this operation" }
			await messenger.escalateTaskletInteraction(child, input, new AbortController().signal)
			const card = messages[0].content.card
			assert.equal(card.header, `tasklet-private · ${response === DiracAskResponse.APPROVE ? "Approved" : "Declined"} by you`)
			assert.match(card.body, /Full operation/)
			assert.match(card.body, /Utility escalated: Policy does not cover this operation/)
			assert.equal(card.collapsed, true)
			assert.deepEqual(card.rawInput, input.card.rawInput)
		})
	}

	it("preserves the operation text of a header-only child request", async () => {
		const { messenger, messages, taskState, messageStateHandler } = createMessenger()
		messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) => {
			submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.REJECT })
		})
		const original = request()
		const input = { ...original, card: { ...original.card, body: "" } }
		await messenger.escalateTaskletInteraction(child, input, new AbortController().signal)
		assert.equal(messages[0].content.card.body, "Execute?")
	})

	for (const cancelled of [false, true]) {
		it(`retains ${cancelled ? "cancelled" : "answered"} header persistence failures as escalation cleanup failures`, async () => {
			const { messenger, taskState, messageStateHandler } = createMessenger()
			const failure = new Error("header persistence failed")
			const cancellation = new AbortController()
			messageStateHandler.patchCardById.callsFake(async (id: string, update: Record<string, unknown>) => {
				if (update.header === `tasklet-private · ${cancelled ? "Request cancelled" : "Approved by you"}`) throw failure
				const message = messageStateHandler.getDiracMessages().find((candidate: any) => candidate.content.card?.id === id)
				Object.assign(message.content.card, update)
				return message.content.card
			})
			messageStateHandler.publishCardInteractionReady.callsFake((cardId: string) => {
				if (cancelled) cancellation.abort(new Error("child retired"))
				else submitCardResponse({ taskState }, { cardId, response: DiracAskResponse.APPROVE })
			})
			await assert.rejects(
				messenger.escalateTaskletInteraction(child, request(), cancellation.signal),
				(error: unknown) => error instanceof TaskletEscalationCleanupError && error.cause === failure,
			)
		})
	}

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
			submitCardResponse({ taskState }, {
				cardId, response: DiracAskResponse.APPROVE, userEdits: { "file.ts": "changed" },
			})
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

	it("preserves newer task status when an owner response resolves", async () => {
		const counterparty = owner()
		let respond!: () => void
		counterparty.requestInteraction.callsFake(() => new Promise<{ action: string }>((resolve) => {
			respond = () => resolve({ action: DiracAskResponse.APPROVE })
		}))
		const { messenger, taskState } = createMessenger(undefined, counterparty)
		taskState.status = TaskStatus.IDLE
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })
		const waiting = card.waitForInteraction()
		await pWaitFor(() => counterparty.requestInteraction.calledOnce, { interval: 1 })
		taskState.status = TaskStatus.WAITING_FOR_API
		respond()
		assert.equal((await waiting).action, DiracAskResponse.APPROVE)
		assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
	})

	it("preserves newer task status when the last of overlapping owner waits is cancelled", async () => {
		const counterparty = owner()
		const { messenger, taskState } = createMessenger(undefined, counterparty)
		taskState.status = TaskStatus.IDLE
		const first = await messenger.createCard({ header: "First", requireFeedback: true })
		const second = await messenger.createCard({ header: "Second", requireFeedback: true })
		const firstRejected = assert.rejects(first.waitForInteraction(), /became terminal/)
		const secondRejected = assert.rejects(second.waitForInteraction(), /became terminal/)
		await pWaitFor(() => counterparty.requestInteraction.calledTwice, { interval: 1 })
		await first.finalize(CardStatus.CANCELLED)
		await firstRejected
		taskState.status = TaskStatus.WAITING_FOR_API
		await second.finalize(CardStatus.CANCELLED)
		await secondRejected
		assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
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
					orchestration: { reportFailure: sinon.spy() },
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

	it("routes legacy response input only to the FIFO head", async () => {
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

	it("resolves addressed simultaneous cards out of order without crossing response fields", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		taskState.status = TaskStatus.WAITING_FOR_API
		const first = await messenger.createCard({ header: "First", requireApproval: true })
		const second = await messenger.createCard({ header: "Second", requireApproval: true })
		let firstSettled = false
		const firstInteraction = first.waitForInteraction().then((result) => { firstSettled = true; return result })
		const secondInteraction = second.waitForInteraction()
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledTwice, { interval: 1 })

		assert.equal(taskState.lastWaitingCardId, first.id)
		await submitCardResponse({ taskState }, {
			cardId: second.id, response: DiracAskResponse.REJECT, text: "Second response",
			images: ["second.png"], files: ["second.txt"], value: "second-value", userEdits: { second: "edit" },
		})
		const secondResult = await withInteractionTimeout(taskState, secondInteraction)
		assert.equal(firstSettled, false)
		assert.equal(secondResult.response, DiracAskResponse.REJECT)
		assert.equal(secondResult.text, "Second response")
		assert.deepEqual(secondResult.images, ["second.png"])
		assert.deepEqual(secondResult.files, ["second.txt"])
		assert.deepEqual(secondResult.userEdits, { second: "edit" })
		assert.equal(secondResult.value, "second-value")
		assert.deepEqual(taskState.waitingCardIds, [first.id])
		assert.equal(taskState.status, TaskStatus.AWAITING_USER_INPUT)

		await submitCardResponse({ taskState }, { cardId: first.id, response: DiracAskResponse.APPROVE, value: "first-value" })
		const firstResult = await withInteractionTimeout(taskState, firstInteraction)
		assert.equal(firstResult.response, DiracAskResponse.APPROVE)
		assert.equal(firstResult.value, "first-value")
		assert.equal(firstResult.text, undefined)
		assert.equal(firstResult.images, undefined)
		assert.equal(firstResult.files, undefined)
		assert.equal(firstResult.userEdits, undefined)
		assert.equal(taskState.pendingCardInteractions.size, 0)
		assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
	})

	it("keeps an addressed response to the second card before either waiter finishes setup", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const first = await messenger.createCard({ header: "First", requireApproval: true })
		const second = await messenger.createCard({ header: "Second", requireApproval: true })
		let release!: () => void
		messageStateHandler.flushPendingWrites.returns(new Promise<void>((resolve) => { release = resolve }))
		const firstInteraction = first.waitForInteraction()
		const secondInteraction = second.waitForInteraction()
		await submitCardResponse({ taskState }, { cardId: second.id, response: DiracAskResponse.REJECT, value: "early" })
		release()
		assert.equal((await withInteractionTimeout(taskState, secondInteraction)).value, "early")
		assert.deepEqual(taskState.waitingCardIds, [first.id])
		await submitCardResponse({ taskState }, { cardId: first.id, response: DiracAskResponse.APPROVE })
		assert.equal((await withInteractionTimeout(taskState, firstInteraction)).response, DiracAskResponse.APPROVE)
		assert.equal(taskState.pendingCardInteractions.size, 0)
	})

	for (const cancelledIndex of [0, 1]) {
		it(`cancels only simultaneous waiter ${cancelledIndex + 1}`, async () => {
			const { messenger, taskState, messageStateHandler } = createMessenger()
			const cards = await Promise.all([
				messenger.createCard({ header: "First", requireApproval: true }),
				messenger.createCard({ header: "Second", requireApproval: true }),
			])
			const controllers = [new AbortController(), new AbortController()]
			const waits = cards.map((card, index) => card.waitForInteraction(controllers[index].signal))
			const cancelled = assert.rejects(waits[cancelledIndex], /cancel just one/)
			await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledTwice, { interval: 1 })
			controllers[cancelledIndex].abort(new Error("cancel just one"))
			await withInteractionTimeout(taskState, cancelled)
			const survivorIndex = 1 - cancelledIndex
			assert.deepEqual(taskState.waitingCardIds, [cards[survivorIndex].id])
			assert.equal(taskState.pendingCardInteractions.size, 1)
			assert.equal(taskState.status, TaskStatus.AWAITING_USER_INPUT)
			await submitCardResponse({ taskState }, { cardId: cards[survivorIndex].id, response: DiracAskResponse.APPROVE })
			assert.equal((await withInteractionTimeout(taskState, waits[survivorIndex])).response, DiracAskResponse.APPROVE)
			assert.equal(taskState.pendingCardInteractions.size, 0)
			assert.equal(taskState.status, TaskStatus.IDLE)
		})
	}

	it("routes addressed chat interruption only to its card without rejecting the current turn", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const first = await messenger.createCard({ header: "First", requireApproval: true })
		const second = await messenger.createCard({ header: "Second", requireApproval: true })
		const firstWait = first.waitForInteraction()
		const secondRejected = assert.rejects(second.waitForInteraction(), (error: unknown) =>
			error instanceof ToolSkippedByUserMessage && error.userMessage === "Change the second operation")
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledTwice, { interval: 1 })
		await submitCardResponse({ taskState }, {
			cardId: second.id, response: DiracAskResponse.MESSAGE, text: "Change the second operation",
		})
		await withInteractionTimeout(taskState, secondRejected)
		assert.equal(taskState.didRejectTool, false)
		assert.deepEqual(taskState.waitingCardIds, [first.id])
		await submitCardResponse({ taskState }, { cardId: first.id, response: DiracAskResponse.APPROVE })
		assert.equal((await withInteractionTimeout(taskState, firstWait)).response, DiracAskResponse.APPROVE)
	})

	it("task abort ends all simultaneous waits and discards their pending responses", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const first = await messenger.createCard({ header: "First", requireApproval: true })
		const second = await messenger.createCard({ header: "Second", requireApproval: true })
		const rejected = Promise.all([
			assert.rejects(first.waitForInteraction(), /abort/i),
			assert.rejects(second.waitForInteraction(), /abort/i),
		])
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledTwice, { interval: 1 })
		await submitCardResponse({ taskState }, { cardId: second.id, response: DiracAskResponse.REJECT })
		taskState.abort = true
		await withInteractionTimeout(taskState, rejected)
		assert.deepEqual(taskState.waitingCardIds, [])
		assert.equal(taskState.pendingCardInteractions.size, 0)
		for (const field of responseFields) assert.equal(taskState[field], undefined, field)
	})

	it("does not replace a concurrent model status when card wait setup finishes", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })
		let release!: () => void
		messageStateHandler.flushPendingWrites.returns(new Promise<void>((resolve) => { release = resolve }))
		const wait = card.waitForInteraction()
		taskState.status = TaskStatus.WAITING_FOR_API
		release()
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
		assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
		await submitCardResponse({ taskState }, { cardId: card.id, response: DiracAskResponse.APPROVE })
		await withInteractionTimeout(taskState, wait)
		assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
	})

	it("does not restore stale status over concurrent model streaming", async () => {
		const { messenger, taskState, messageStateHandler } = createMessenger()
		const card = await messenger.createCard({ header: "Permission", requireApproval: true })
		const wait = card.waitForInteraction()
		await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
		taskState.status = TaskStatus.WAITING_FOR_API
		await submitCardResponse({ taskState }, { cardId: card.id, response: DiracAskResponse.APPROVE })
		await withInteractionTimeout(taskState, wait)
		assert.equal(taskState.status, TaskStatus.WAITING_FOR_API)
	})

	it("cancels and joins only the matching notification hook before unregistering its wait", async () => {
		const fixture = createMessenger(undefined, undefined, true)
		const { messenger, taskState, messageStateHandler } = fixture
		const hooks: any[] = []
		const finishHooks: (() => void)[] = []
		const execute = sinon.stub(hookExecutor, "executeHook").callsFake(async (options) => {
			hooks.push(options)
			return new Promise<any>((resolve) => { finishHooks.push(() => resolve(undefined)) })
		})
		try {
			const first = await messenger.createCard({ header: "First", requireApproval: true })
			const second = await messenger.createCard({ header: "Second", requireApproval: true })
			const controller = new AbortController()
			let firstSettled = false
			const firstWait = first.waitForInteraction(controller.signal).finally(() => { firstSettled = true })
			const firstRejected = assert.rejects(firstWait, /cancel notification/)
			const secondWait = second.waitForInteraction()
			await pWaitFor(() => hooks.length === 2, { interval: 1 })
			assert.equal(hooks[0].setActiveHookExecution, fixture.setActiveHookExecution)
			assert.equal(hooks[0].clearActiveHookExecution, fixture.clearActiveHookExecution)
			controller.abort(new Error("cancel notification"))
			assert.equal(hooks[0].signal.aborted, true)
			assert.equal(hooks[1].signal.aborted, false)
			await new Promise<void>((resolve) => setImmediate(resolve))
			assert.equal(firstSettled, false, "wait must join hook cleanup, not abandon it")
			assert.equal(taskState.pendingCardInteractions.size, 2)
			finishHooks[0]()
			await withInteractionTimeout(taskState, firstRejected)
			assert.deepEqual(taskState.waitingCardIds, [second.id])
			assert.equal(hooks[1].signal.aborted, false)
			finishHooks[1]()
			await pWaitFor(() => messageStateHandler.publishCardInteractionReady.calledOnce, { interval: 1 })
			await submitCardResponse({ taskState }, { cardId: second.id, response: DiracAskResponse.APPROVE })
			assert.equal((await withInteractionTimeout(taskState, secondWait)).response, DiracAskResponse.APPROVE)
			assert.equal(taskState.pendingCardInteractions.size, 0)
		} finally {
			execute.restore()
		}
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
		assert.equal(taskState.didRejectTool, false)
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
