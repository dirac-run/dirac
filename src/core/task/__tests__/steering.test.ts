import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import Mutex from "p-mutex"
import sinon from "sinon"
import { DiracMessageType, SteeringTranscriptStatus, TaskStatus } from "@shared/ExtensionMessage"
import { Task } from "../index"
import { formatSteeringMessages, SteeringDeliveryState } from "../steering"
import { TaskState } from "../TaskState"

function createSteerableTask() {
	const messages: any[] = []
	const task = Object.create(Task.prototype) as any
	task.taskState = new TaskState()
	task.taskState.status = TaskStatus.EXECUTING_TOOL
	task.stateMutex = new Mutex()
	task.taskMessenger = { generateId: sinon.stub().returns("transcript-1") }
	task.messageStateHandler = {
		addToDiracMessages: sinon.stub().callsFake(async (message) => messages.push(message)),
		findMessageIndexById: sinon.stub().callsFake((id: string) => messages.findIndex((message) => message.id === id)),
		getMessageById: sinon.stub().callsFake((id: string) => messages.find((message) => message.id === id)),
		getDiracMessages: sinon.stub().callsFake(() => messages),
		updateDiracMessage: sinon.stub().callsFake(async (index: number, update: any) => Object.assign(messages[index], update)),
		patchMarkdownById: sinon.stub().callsFake(async (id: string, patch: any) => {
			const message = messages.find((candidate) => candidate.id === id)
			if (!message || message.content.type !== DiracMessageType.MARKDOWN) throw new Error(`Markdown ${id} not found`)
			Object.assign(message.content, patch)
		}),
	}
	task.messageStateHandler.getApiConversationHistory = sinon.stub().callsFake(() => task.apiConversationHistory)
	task.messageStateHandler.getApiConversationProviderState = sinon.stub().returns({})
	task.messageStateHandler.recordDeliveredSteeringMessageIds = sinon.stub().resolves()
	task.messageStateHandler.saveDiracMessagesAndUpdateHistory = sinon.stub().resolves()
	task.messageStateHandler.flushPendingWrites = sinon.stub().resolves()
	task.messageStateHandler.addToApiConversationHistory = sinon.stub().callsFake(async (message: any) => {
		task.apiConversationHistory.push(structuredClone(message))
	})

	task.messageStateHandler.appendToLastApiConversationUserMessage = sinon.stub().callsFake(async (contentBlock: any) => {
		const lastMessage = task.apiConversationHistory.at(-1)
		if (!lastMessage || lastMessage.role !== "user") throw new Error("missing user message")
		if (typeof lastMessage.content === "string") {
			lastMessage.content = [{ type: "text", text: lastMessage.content }, contentBlock]
		} else {
			lastMessage.content.push(contentBlock)
		}
		return lastMessage
	})
	task.apiConversationHistory = []
	task.postStateToWebview = sinon.stub().resolves()
	return { task, messages }
}

describe("Task steering inbox", () => {
	it("queues guidance independently of unanswered and answered approval waiters", async () => {
		const { task } = createSteerableTask()
		task.taskState.status = TaskStatus.AWAITING_USER_INPUT
		task.taskState.waitingCardIds = ["permission"]
		const pending = { signal: new AbortController().signal, response: undefined as { action: string } | undefined }
		task.taskState.pendingCardInteractions.set("permission", pending)
		await task.enqueueSteeringMessage("Keep this draft separate")
		assert.equal(pending.response, undefined)
		pending.response = { action: "approve" }
		await task.enqueueSteeringMessage("More guidance before waiter cleanup")
		assert.deepEqual(pending.response, { action: "approve" })
		assert.equal(task.taskState.steeringMessages.length, 2)
		assert.equal(task.taskState.status, TaskStatus.AWAITING_USER_INPUT)
		assert.equal(task.taskState.didRejectTool, false)
	})

	it("enqueues a queued user transcript message without interrupting task state", async () => {
		const { task, messages } = createSteerableTask()

		await task.enqueueSteeringMessage("Use <existing> & safe helpers.")

		assert.equal(task.taskState.status, TaskStatus.EXECUTING_TOOL)
		assert.equal(task.taskState.didRejectTool, false)
		assert.equal(task.taskState.steeringMessages.length, 1)
		assert.equal(task.taskState.steeringMessages[0].deliveryState, SteeringDeliveryState.QUEUED)
		assert.equal(messages.length, 1)
		assert.equal(messages[0].content.type, DiracMessageType.MARKDOWN)
		assert.equal(messages[0].content.role, "user")
		assert.deepEqual(messages[0].content.steering, { status: SteeringTranscriptStatus.QUEUED })
	})

	it("claims FIFO messages, escapes XML, and marks transcripts sent on commit", async () => {
		const { task, messages } = createSteerableTask()
		task.taskMessenger.generateId.onFirstCall().returns("transcript-1").onSecondCall().returns("transcript-2")
		await task.enqueueSteeringMessage("First <message>")
		await task.enqueueSteeringMessage("Second & message")

		const claim = await task.claimSteeringMessages()
		assert.deepEqual(
			claim.messages.map((message: any) => message.text),
			["First <message>", "Second & message"],
		)
		const formatted = formatSteeringMessages(claim.messages)
		assert.ok(formatted.includes("<steering_message>First &lt;message&gt;</steering_message>"))
		assert.ok(formatted.includes("<steering_message>Second &amp; message</steering_message>"))

		await task.commitSteeringClaim(claim.id)
		assert.deepEqual(
			task.taskState.steeringMessages.map((message: any) => message.deliveryState),
			[SteeringDeliveryState.SENT, SteeringDeliveryState.SENT],
		)
		assert.deepEqual(
			messages.map((message) => message.content.steering),
			[{ status: SteeringTranscriptStatus.SENT }, { status: SteeringTranscriptStatus.SENT }],
		)
	})

	it("persists a sent transcript fallback when delivery-receipt persistence fails", async () => {
		const { task, messages } = createSteerableTask()
		await task.enqueueSteeringMessage("/reloadtools")
		const claim = await task.claimSteeringMessages()
		task.messageStateHandler.recordDeliveredSteeringMessageIds.rejects(new Error("receipt write failed"))

		await assert.rejects(task.settleConsumedSteeringClaim(claim), /receipt write failed/)

		assert.equal(task.taskState.steeringMessages[0].deliveryState, SteeringDeliveryState.SENT)
		assert.deepEqual(messages[0].content.steering, { status: SteeringTranscriptStatus.SENT })
		assert.equal(task.messageStateHandler.saveDiracMessagesAndUpdateHistory.callCount, 1)
	})

	it("rolls a failed request claim back while leaving later guidance queued", async () => {
		const { task } = createSteerableTask()
		task.taskMessenger.generateId.onFirstCall().returns("transcript-1").onSecondCall().returns("transcript-2")
		await task.enqueueSteeringMessage("Claim me")
		const claim = await task.claimSteeringMessages()
		await task.enqueueSteeringMessage("Arrived after claim")

		await task.rollbackSteeringClaim(claim.id)

		assert.deepEqual(
			task.taskState.steeringMessages.map((message: any) => message.deliveryState),
			[SteeringDeliveryState.QUEUED, SteeringDeliveryState.QUEUED],
		)
	})

	it("restores only queued steering from transcript metadata", () => {
		const { task, messages } = createSteerableTask()
		messages.push(
			{
				id: "queued-transcript",
				ts: 1,
				content: {
					type: DiracMessageType.MARKDOWN,
					content: "Restore me",
					role: "user",
					steering: { status: SteeringTranscriptStatus.QUEUED },
				},
			},
			{
				id: "sent-transcript",
				ts: 2,
				content: {
					type: DiracMessageType.MARKDOWN,
					content: "Already sent",
					role: "user",
					steering: { status: SteeringTranscriptStatus.SENT },
				},
			},
		)

		task.restoreQueuedSteeringFromTranscript()

		assert.deepEqual(task.taskState.steeringMessages, [
			{
				id: "queued-transcript",
				text: "Restore me",
				createdAt: 1,
				transcriptMessageId: "queued-transcript",
				deliveryState: SteeringDeliveryState.QUEUED,
			},
		])
	})

	it("does not restore queued transcripts covered by persisted delivery receipts", () => {
		const { task, messages } = createSteerableTask()
		messages.push({
			id: "delivered-transcript",
			ts: 1,
			content: {
				type: DiracMessageType.MARKDOWN,
				content: "/reloadtools",
				role: "user",
				steering: { status: SteeringTranscriptStatus.QUEUED },
			},
		})
		task.messageStateHandler.getApiConversationProviderState.returns({
			deliveredSteeringMessageIds: ["delivered-transcript"],
		})

		task.restoreQueuedSteeringFromTranscript()

		assert.deepEqual(task.taskState.steeringMessages, [])
	})

	it("queued steering supersedes an uncommitted attempt completion", async () => {
		const { task } = createSteerableTask()
		task.taskState.didAttemptCompletion = true
		await task.enqueueSteeringMessage("Continue before completing")

		assert.deepEqual(await task.commitAttemptCompletion("Done"), {
			committed: false,
			error: "Completion was superseded by queued user steering.",
		})
		assert.equal(task.taskState.didAttemptCompletion, false)
		assert.equal(task.taskState.status, TaskStatus.EXECUTING_TOOL)
	})

	it("commits completion when no steering was queued", async () => {
		const { task } = createSteerableTask()
		task.taskState.didAttemptCompletion = true

		assert.deepEqual(await task.commitAttemptCompletion("Done"), { committed: true })
		assert.equal(task.taskState.completionCommitted, true)
		assert.equal(task.taskState.completionResponse, "Done")
		assert.equal(task.taskState.askResponse, undefined)
		assert.equal(task.taskState.askResponseText, undefined)
		assert.equal(task.taskState.status, TaskStatus.EXECUTING_TOOL)
	})

	it("preserves completed status while accepting a follow-up after completion was sealed", async () => {
		const { task } = createSteerableTask()
		task.taskState.status = TaskStatus.COMPLETED
		task.taskState.askResponse = "message"
		task.taskState.askResponseText = "Immediate follow-up"

		const followUp = await task.waitForFollowUp()

		assert.equal(task.taskState.status, TaskStatus.COMPLETED)
		assert.deepEqual(followUp, [{ type: "text", text: "<feedback>\nImmediate follow-up\n</feedback>", isUserInput: true }])
	})

	it("does not let a stale plan-response flag reject steering without a waiting card", async () => {
		const { task } = createSteerableTask()
		task.taskState.isAwaitingPlanResponse = true

		assert.equal(task.canAcceptSteeringMessage(), true)
		await task.enqueueSteeringMessage("Continue with the active task")
		assert.equal(task.taskState.steeringMessages.length, 1)
	})

	it("marks queued steering as user input before context parsing", async () => {
		const { task } = createSteerableTask()
		const userContent: any[] = [{ type: "tool_result", tool_use_id: "tool-1", content: "tool output" }]
		await task.enqueueSteeringMessage("/compact")

		const claim = await task.appendQueuedSteeringToUserContent(userContent)

		assert.ok(claim)
		assert.equal(userContent.at(-1).isUserInput, true)
		assert.ok(userContent.at(-1).text.includes("<steering_message>/compact</steering_message>"))
	})

	it("preserves FIFO while limiting a queued batch to the first steering command", async () => {
		const { task } = createSteerableTask()
		task.taskMessenger.generateId
			.onFirstCall()
			.returns("transcript-1")
			.onSecondCall()
			.returns("transcript-2")
			.onThirdCall()
			.returns("transcript-3")
		await task.enqueueSteeringMessage("Keep the current API shape")
		await task.enqueueSteeringMessage("/compact")
		await task.enqueueSteeringMessage("/reloadtools")
		const userContent: any[] = []

		const claim = await task.appendQueuedSteeringToUserContent(userContent)

		assert.deepEqual(
			claim.messages.map((message: any) => message.text),
			["Keep the current API shape"],
		)
		assert.equal(userContent.length, 1)
		assert.ok(userContent[0].text.includes("Keep the current API shape"))
		assert.deepEqual(
			task.taskState.steeringMessages.map((message: any) => message.deliveryState),
			[SteeringDeliveryState.CLAIMED, SteeringDeliveryState.QUEUED, SteeringDeliveryState.QUEUED],
		)

		await task.commitSteeringClaim(claim.id)
		const commandContent: any[] = []
		const commandClaim = await task.appendQueuedSteeringToUserContent(commandContent)
		assert.deepEqual(
			commandClaim.messages.map((message: any) => message.text),
			["/compact"],
		)
		assert.ok(commandContent[0].text.includes("<steering_message>/compact</steering_message>"))
		assert.deepEqual(
			task.taskState.steeringMessages.map((message: any) => message.deliveryState),
			[SteeringDeliveryState.SENT, SteeringDeliveryState.CLAIMED, SteeringDeliveryState.QUEUED],
		)
	})

	it("defers late command-shaped steering to the next context-loading boundary", async () => {
		const { task, messages } = createSteerableTask()
		const toolResult = { type: "tool_result", tool_use_id: "tool-1", content: "tool output" }
		const persistedUserMessage = { role: "user", content: [toolResult] }
		const outboundUserMessage = { role: "user", content: [toolResult] }
		task.apiConversationHistory.push(persistedUserMessage)
		task.taskMessenger.generateId.onFirstCall().returns("transcript-1").onSecondCall().returns("transcript-2")
		await task.enqueueSteeringMessage("ordinary late guidance")
		await task.enqueueSteeringMessage("/reloadtools")

		await task.appendQueuedSteeringToNextApiRequest([outboundUserMessage])

		assert.equal(persistedUserMessage.content.length, 1)
		assert.equal(outboundUserMessage.content.length, 1)
		assert.equal(task.taskState.steeringMessages[0].deliveryState, SteeringDeliveryState.QUEUED)
		assert.deepEqual(messages[0].content.steering, { status: SteeringTranscriptStatus.QUEUED })
	})

	it("attaches queued steering to the next outbound tool-result request", async () => {
		const { task, messages } = createSteerableTask()
		const toolResult = { type: "tool_result", tool_use_id: "tool-1", content: "tool output" }
		const persistedUserMessage = { role: "user", content: [toolResult] }
		const outboundUserMessage = { role: "user", content: [toolResult] }
		task.apiConversationHistory.push(persistedUserMessage)

		await task.enqueueSteeringMessage("Use the enum helper")
		await task.appendQueuedSteeringToNextApiRequest([outboundUserMessage])

		assert.equal(persistedUserMessage.content[0], toolResult)
		assert.equal(outboundUserMessage.content[0], toolResult)
		assert.ok(
			(persistedUserMessage.content.at(-1) as any).text.includes(
				"<steering_message>Use the enum helper</steering_message>",
			),
		)
		assert.ok(
			(outboundUserMessage.content.at(-1) as any).text.includes("<steering_message>Use the enum helper</steering_message>"),
		)
		assert.deepEqual(messages[0].content.steering, { status: SteeringTranscriptStatus.SENT })
		assert.deepEqual((persistedUserMessage.content.at(-1) as any).steeringMessageIds, ["transcript-1"])
	})
	it("does not requeue late steering after API history has already consumed it", async () => {
		const { task } = createSteerableTask()
		const toolResult = { type: "tool_result", tool_use_id: "tool-1", content: "tool output" }
		const persistedUserMessage = { role: "user", content: [toolResult] }
		const outboundUserMessage = { role: "user", content: [toolResult] }
		task.apiConversationHistory.push(persistedUserMessage)
		await task.enqueueSteeringMessage("Persist exactly once")
		task.messageStateHandler.patchMarkdownById.rejects(new Error("transcript update failed"))

		await assert.rejects(task.appendQueuedSteeringToNextApiRequest([outboundUserMessage]), /transcript update failed/)

		assert.equal(persistedUserMessage.content.length, 2)
		assert.equal(outboundUserMessage.content.length, 2)
		assert.equal(task.taskState.steeringMessages[0].deliveryState, SteeringDeliveryState.SENT)
		task.restoreQueuedSteeringFromTranscript()
		assert.deepEqual(task.taskState.steeringMessages, [])
	})

	it("does not duplicate staged late steering after a conversation flush fails", async () => {
		const { task } = createSteerableTask()
		await task.enqueueSteeringMessage("Late feedback")
		task.apiConversationHistory.push({ role: "user", content: [{ type: "text", text: "Tool response" }] })
		task.messageStateHandler.flushPendingWrites.rejects(new Error("disk full"))
		await assert.rejects(task.appendQueuedSteeringToNextApiRequest(task.apiConversationHistory), /disk full/)
		assert.equal(task.taskState.steeringMessages[0].deliveryState, SteeringDeliveryState.QUEUED)
		sinon.assert.notCalled(task.messageStateHandler.recordDeliveredSteeringMessageIds)
		task.messageStateHandler.flushPendingWrites.resolves()
		await task.appendQueuedSteeringToNextApiRequest(task.apiConversationHistory)
		assert.equal(task.apiConversationHistory[0].content.length, 2)
		assert.equal(task.messageStateHandler.appendToLastApiConversationUserMessage.callCount, 1)
		assert.equal(task.taskState.steeringMessages[0].deliveryState, SteeringDeliveryState.SENT)
		sinon.assert.calledTwice(task.messageStateHandler.flushPendingWrites)
		sinon.assert.calledOnce(task.messageStateHandler.recordDeliveredSteeringMessageIds)
	})

	for (const sharedHistory of [true, false]) {
		it(`materializes retry steering after the checkpoint before marking it sent (${sharedHistory ? "shared" : "copied"} history)`, async () => {
			const { task, messages } = createSteerableTask()
			task.apiConversationHistory.push({ role: "user", content: "covered assignment" })
			const checkpoint = {
				providerId: "provider",
				modelId: "model",
				compactedThroughHistoryIndex: 0,
				input: [{ type: "opaque-reasoning", encrypted: "preserve-me" }],
			}
			task.messageStateHandler.getApiConversationProviderState.returns({ checkpoint })
			const outbound = sharedHistory ? task.apiConversationHistory : structuredClone(task.apiConversationHistory)
			await task.enqueueSteeringMessage("Guidance received during retry")

			await task.appendQueuedSteeringToNextApiRequest(outbound)

			assert.deepEqual(task.apiConversationHistory[0], { role: "user", content: "covered assignment" })
			assert.deepEqual(outbound[0], { role: "user", content: "covered assignment" })
			assert.equal(task.apiConversationHistory.length, 2)
			assert.equal(outbound.length, 2)
			assert.match(JSON.stringify(task.apiConversationHistory[1]), /Guidance received during retry/)
			assert.deepEqual(task.apiConversationHistory[1].content[0].steeringMessageIds, ["transcript-1"])
			assert.deepEqual(messages[0].content.steering, { status: SteeringTranscriptStatus.SENT })
			sinon.assert.notCalled(task.messageStateHandler.appendToLastApiConversationUserMessage)
			sinon.assert.callOrder(
				task.messageStateHandler.addToApiConversationHistory,
				task.messageStateHandler.flushPendingWrites,
				task.messageStateHandler.recordDeliveredSteeringMessageIds,
				task.messageStateHandler.patchMarkdownById,
			)
		})
	}

	it("does not restore checkpointed steering after a durable conversation write but a failed receipt and transcript write", async () => {
		const { task, messages } = createSteerableTask()
		task.apiConversationHistory.push({ role: "user", content: "covered assignment" })
		task.messageStateHandler.getApiConversationProviderState.returns({
			checkpoint: { providerId: "provider", modelId: "model", compactedThroughHistoryIndex: 0, input: [] },
		})
		await task.enqueueSteeringMessage("Deliver only once")
		task.messageStateHandler.recordDeliveredSteeringMessageIds.rejects(new Error("receipt unavailable"))
		task.messageStateHandler.patchMarkdownById.rejects(new Error("transcript unavailable"))

		await assert.rejects(task.appendQueuedSteeringToNextApiRequest(task.apiConversationHistory), AggregateError)

		assert.deepEqual(messages[0].content.steering, { status: SteeringTranscriptStatus.QUEUED })
		assert.equal(task.apiConversationHistory.length, 2)
		task.restoreQueuedSteeringFromTranscript()
		assert.deepEqual(task.taskState.steeringMessages, [])
		task.messageStateHandler.recordDeliveredSteeringMessageIds.resolves()
		task.messageStateHandler.patchMarkdownById.resolves()
		await task.appendQueuedSteeringToNextApiRequest(task.apiConversationHistory)
		sinon.assert.calledOnce(task.messageStateHandler.addToApiConversationHistory)
	})

	it("keeps a consumed claim sent when durable receipt persistence fails", async () => {
		const { task, messages } = createSteerableTask()
		await task.enqueueSteeringMessage("/reloadtools")
		const claim = await task.claimSteeringMessages()
		task.messageStateHandler.recordDeliveredSteeringMessageIds.rejects(new Error("receipt persistence failed"))

		await assert.rejects(task.settleConsumedSteeringClaim(claim), /receipt persistence failed/)

		assert.equal(task.taskState.steeringMessages[0].deliveryState, SteeringDeliveryState.SENT)
		assert.deepEqual(messages[0].content.steering, { status: SteeringTranscriptStatus.SENT })
		task.restoreQueuedSteeringFromTranscript()
		assert.deepEqual(task.taskState.steeringMessages, [])
	})
})
