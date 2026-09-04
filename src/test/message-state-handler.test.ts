import { expect } from "chai"
import * as fs from "fs"
import { afterEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import {
	MAX_PENDING_PRESENTATION_PUBLICATION_BYTES,
	MessageStateHandler,
	UI_MESSAGES_FLUSH_MAX_DELAY_MS,
} from "../core/task/message-state"
import { TaskState } from "../core/task/TaskState"
import { CardStatus, DiracMessage, DiracMessageType } from "../shared/ExtensionMessage"
import { setVscodeHostProviderMock } from "./host-provider-test-utils"

/**
 * Unit tests for MessageStateHandler's mutex protection (RC-4)
 * These tests verify that concurrent operations on message state are properly serialized
 * to prevent race conditions, particularly the TOCTOU bug in addToDiracMessages
 */
describe("MessageStateHandler Mutex Protection", () => {
	let tmpDir: string
	let createdHandlers: MessageStateHandler[] = []
	let handlerId = 0

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirac-msh-test-"))
		setVscodeHostProviderMock({ globalStorageFsPath: tmpDir })
	})

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true })
		HostProvider.reset()
	})

	afterEach(async () => {
		await Promise.all(createdHandlers.map((handler) => handler.flushPendingWrites()))
		createdHandlers = []
	})

	/**
	 * Helper to create a minimal MessageStateHandler for testing
	 */
	function createTestHandler(taskId = `test-task-id-${++handlerId}`): MessageStateHandler {
		const taskState = new TaskState()
		const handler = new MessageStateHandler({
			taskId,
			ulid: "test-ulid",
			taskState,
			updateTaskHistory: async () => [],
		})
		createdHandlers.push(handler)
		return handler
	}

	/**
	 * Helper to create a test DiracMessage
	 */
	function createTestMessage(text: string): DiracMessage {
		return {
			id: `test-msg-${Date.now()}-${Math.random()}`,
			ts: Date.now(),
			content: {
				type: DiracMessageType.MARKDOWN,
				content: text,
			},
		}
	}

	it("should initialize with empty message arrays", () => {
		const handler = createTestHandler()
		expect(handler.getDiracMessages().length).to.equal(0)
		expect(handler.getApiConversationHistory().length).to.equal(0)
	})

	it("should set and get API conversation history", () => {
		const handler = createTestHandler()
		const testHistory = [{ role: "user" as const, content: "test message" }]

		handler.setApiConversationHistory(testHistory)
		expect(handler.getApiConversationHistory()).to.deep.equal(testHistory)
	})

	it("should set and get dirac messages", () => {
		const handler = createTestHandler()
		const testMessages = [createTestMessage("test1"), createTestMessage("test2")]

		handler.setDiracMessages(testMessages)
		expect(handler.getDiracMessages()).to.deep.equal(testMessages)
	})

	/**
	 * CRITICAL TEST: Verify that addToDiracMessages is atomic
	 * This test simulates the race condition that can occur when multiple
	 * addToDiracMessages calls happen concurrently without proper mutex protection
	 */
	it("should handle concurrent addToDiracMessages atomically", async function () {
		// Increase timeout for this test as it involves async operations
		this.timeout(5000)

		const handler = createTestHandler()

		// Set up initial API conversation history
		const initialHistory = [
			{ role: "user" as const, content: "msg1" },
			{ role: "assistant" as const, content: "response1" },
			{ role: "user" as const, content: "msg2" },
		]
		handler.setApiConversationHistory(initialHistory)

		// Add initial message to establish baseline
		const initialMsg = createTestMessage("initial")
		await handler.addToDiracMessages(initialMsg)

		// Verify initial state
		const messages = handler.getDiracMessages()
		expect(messages.length).to.equal(1)
		expect(messages[0].conversationHistoryIndex).to.equal(2) // length - 1 = 3 - 1 = 2

		// Now simulate concurrent additions
		// Without mutex protection, these could race and get the same index
		const msg1 = createTestMessage("concurrent1")
		const msg2 = createTestMessage("concurrent2")
		const msg3 = createTestMessage("concurrent3")

		// Add more messages to API history to simulate ongoing conversation
		handler.setApiConversationHistory([
			...initialHistory,
			{ role: "assistant" as const, content: "response2" },
			{ role: "user" as const, content: "msg3" },
		])

		// Execute concurrent operations
		const results = await Promise.all([
			handler.addToDiracMessages(msg1),
			handler.addToDiracMessages(msg2),
			handler.addToDiracMessages(msg3),
		])

		// Verify all operations completed
		expect(results.length).to.equal(3)

		// Get final state
		const finalMessages = handler.getDiracMessages()
		expect(finalMessages.length).to.equal(4) // initial + 3 concurrent

		// CRITICAL ASSERTION: Each message should have a valid conversationHistoryIndex
		// With proper mutex protection, these indices should be set correctly
		// even though the operations ran concurrently
		finalMessages.forEach((msg) => {
			expect(msg.conversationHistoryIndex).to.be.a("number")
			expect(msg.conversationHistoryIndex).to.be.at.least(0)
		})
	})

	/**
	 * Test that updateDiracMessage operations are atomic
	 */
	it("should handle concurrent updateDiracMessage atomically", async function () {
		this.timeout(5000)

		const handler = createTestHandler()

		// Set up initial messages
		const msgs = [createTestMessage("msg1"), createTestMessage("msg2"), createTestMessage("msg3")]
		handler.setDiracMessages(msgs)

		// Perform concurrent updates to different messages
		await Promise.all([
			handler.updateDiracMessage(0, { content: { type: DiracMessageType.MARKDOWN, content: "updated1" } }),
			handler.updateDiracMessage(1, { content: { type: DiracMessageType.MARKDOWN, content: "updated2" } }),
			handler.updateDiracMessage(2, { content: { type: DiracMessageType.MARKDOWN, content: "updated3" } }),
		])

		const finalMessages = handler.getDiracMessages()
		expect((finalMessages[0]?.content as any)?.content).to.equal("updated1")
		expect((finalMessages[1]?.content as any)?.content).to.equal("updated2")
		expect((finalMessages[2]?.content as any)?.content).to.equal("updated3")
	})

	/**
	 * Test that deleteDiracMessage operations are atomic
	 */
	it("should handle deleteDiracMessage with proper validation", async () => {
		const handler = createTestHandler()

		// Set up initial messages
		const msgs = [createTestMessage("msg1"), createTestMessage("msg2"), createTestMessage("msg3")]
		handler.setDiracMessages(msgs)

		// Delete middle message
		await handler.deleteDiracMessage(1)

		const finalMessages = handler.getDiracMessages()
		expect(finalMessages.length).to.equal(2)
		expect((finalMessages[0]?.content as any)?.content).to.equal("msg1")
		expect((finalMessages[1]?.content as any)?.content).to.equal("msg3")
	})

	/**
	 * Test that invalid indices are rejected
	 */
	it("should throw error for invalid message index in updateDiracMessage", async () => {
		const handler = createTestHandler()
		handler.setDiracMessages([createTestMessage("msg1")])

		try {
			await handler.updateDiracMessage(5, { content: { type: DiracMessageType.MARKDOWN, content: "invalid" } })
			throw new Error("Should have thrown")
		} catch (error) {
			if (error instanceof Error) {
				expect(error.message).to.match(/Invalid message index/)
			}
		}
	})

	/**
	 * Test that invalid indices are rejected in deleteDiracMessage
	 */
	it("should throw error for invalid message index in deleteDiracMessage", async () => {
		const handler = createTestHandler()
		handler.setDiracMessages([createTestMessage("msg1")])

		try {
			await handler.deleteDiracMessage(-1)
			throw new Error("Should have thrown")
		} catch (error) {
			if (error instanceof Error) {
				expect(error.message).to.match(/Invalid message index/)
			}
		}
	})

	/**
	 * Test API conversation history operations
	 */
	it("should handle concurrent API conversation history operations", async function () {
		this.timeout(5000)

		const handler = createTestHandler()

		// Perform concurrent additions
		await Promise.all([
			handler.addToApiConversationHistory({ role: "user", content: "msg1", ts: Date.now() }),
			handler.addToApiConversationHistory({ role: "assistant", content: "response1", ts: Date.now() }),
			handler.addToApiConversationHistory({ role: "user", content: "msg2", ts: Date.now() }),
		])

		const history = handler.getApiConversationHistory()
		expect(history.length).to.equal(3)
		expect(history[0].role).to.equal("user")
		expect(history[1].role).to.equal("assistant")
		expect(history[2].role).to.equal("user")
	})

	/**
	 * Test overwrite operations
	 */
	it("should handle overwriteDiracMessages atomically", async () => {
		const handler = createTestHandler()

		// Set initial messages
		handler.setDiracMessages([createTestMessage("old1"), createTestMessage("old2")])

		// Overwrite with new messages
		const newMessages = [createTestMessage("new1"), createTestMessage("new2"), createTestMessage("new3")]
		await handler.overwriteDiracMessages(newMessages)

		const finalMessages = handler.getDiracMessages()
		expect(finalMessages.length).to.equal(3)
		expect((finalMessages[0]?.content as any)?.content).to.equal("new1")
		expect((finalMessages[1]?.content as any)?.content).to.equal("new2")
		expect((finalMessages[2]?.content as any)?.content).to.equal("new3")
	})

	/**
	 * Test overwrite API conversation history
	 */
	it("should handle overwriteApiConversationHistory atomically", async () => {
		const handler = createTestHandler()

		// Set initial history
		handler.setApiConversationHistory([{ role: "user", content: "old", ts: Date.now() }])

		// Overwrite with new history
		const newHistory = [
			{ role: "user" as const, content: "new1", ts: Date.now() },
			{ role: "assistant" as const, content: "new2", ts: Date.now() },
		]
		await handler.overwriteApiConversationHistory(newHistory)

		const finalHistory = handler.getApiConversationHistory()
		expect(finalHistory.length).to.equal(2)
		expect(finalHistory[0].content).to.equal("new1")
		expect(finalHistory[1].content).to.equal("new2")
	})

	it("strips transient provenance at every API history write boundary", async () => {
		const handler = createTestHandler()
		handler.setApiConversationHistory([{ role: "user", content: [{ type: "text", text: "set", isUserInput: true }] }])
		expect((handler.getApiConversationHistory()[0].content as any[])[0]).not.to.have.property("isUserInput")

		await handler.addToApiConversationHistory({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tool-1",
					content: [{ type: "text", text: "nested", isUserInput: true }],
				},
			],
		} as any)
		const nestedBlock = (handler.getApiConversationHistory()[1].content as any[])[0].content[0]
		expect(nestedBlock).not.to.have.property("isUserInput")

		await handler.appendToLastApiConversationUserMessage({ type: "text", text: "append", isUserInput: true })
		const appendedBlock = (handler.getApiConversationHistory()[1].content as any[]).at(-1)
		expect(appendedBlock).not.to.have.property("isUserInput")

		await handler.overwriteApiConversationHistory([
			{ role: "user", content: [{ type: "text", text: "overwrite", isUserInput: true }] },
		])
		expect((handler.getApiConversationHistory()[0].content as any[])[0]).not.to.have.property("isUserInput")
	})

	it("bounds streaming UI snapshot flushes and preserves explicit flush boundaries", async () => {
		let dateNow: sinon.SinonStub | undefined

		const clock = sinon.useFakeTimers()
		try {
			const handler = createTestHandler()
			const flushPendingWrites = sinon.spy(handler, "flushPendingWrites")
			const message = createTestMessage("streaming")
			await handler.addToDiracMessages(message)
			const index = handler.findMessageIndexById(message.id)
			dateNow = sinon.stub(Date, "now").returns(-10_000)

			for (let elapsed = 0; elapsed < UI_MESSAGES_FLUSH_MAX_DELAY_MS; elapsed += 100) {
				await handler.updateDiracMessage(index, {
					content: { type: DiracMessageType.MARKDOWN, content: `chunk ${elapsed}` },
				})
				await clock.tickAsync(100)
			}

			expect(flushPendingWrites.callCount).to.equal(1)

			await handler.updateDiracMessage(index, {
				content: { type: DiracMessageType.MARKDOWN, content: "final chunk" },
			})
			await handler.flushPendingWrites()
			expect(flushPendingWrites.callCount).to.equal(2)
			await clock.tickAsync(UI_MESSAGES_FLUSH_MAX_DELAY_MS)
			expect(flushPendingWrites.callCount).to.equal(2)
		} finally {
			dateNow?.restore()
			clock.restore()
		}
	})

	it("records status patches and stream appends without unchanged prefixes", async () => {
		const handler = createTestHandler()
		const largeBody = `sentinel-${"x".repeat(2 * 1024 * 1024)}`
		handler.setDiracMessages([
			{
				id: "large-card",
				ts: 1,
				content: {
					type: DiracMessageType.CARD,
					card: { id: "large-card", header: "large", status: CardStatus.RUNNING, renderType: "text", body: largeBody },
				},
			},
			{ id: "stream", ts: 2, content: { type: DiracMessageType.MARKDOWN, content: largeBody } },
			{
				id: "api-status",
				ts: 3,
				content: {
					type: DiracMessageType.API_STATUS,
					status: { request: largeBody, retryStatus: { attempt: 1, maxAttempts: 3, delaySec: 2 } },
				},
			},
		])

		await handler.patchCardById("large-card", { status: CardStatus.SUCCESS })
		await handler.appendMarkdownById("stream", "tail-chunk")
		await handler.patchApiStatusById("api-status", { cost: 0.25 }, ["retryStatus"])
		const encoded = JSON.stringify(handler.getPendingPresentationOperations())

		expect(encoded).to.contain("tail-chunk")
		expect(encoded).not.to.contain("sentinel-")
		expect(Buffer.byteLength(encoded)).to.be.lessThan(1024)
		const apiStatus = handler.getLatestApiStatusMessage()
		expect(apiStatus?.content.type).to.equal(DiracMessageType.API_STATUS)
		if (apiStatus?.content.type !== DiracMessageType.API_STATUS) throw new Error("Expected latest API status")
		expect(apiStatus.content.status.request).to.equal(largeBody)
		expect(apiStatus.content.status.retryStatus).to.equal(undefined)
		expect(apiStatus.content.status.cost).to.equal(0.25)
	})

	it("forces hydration when publication operations exceed the bounded buffer", async () => {
		const handler = createTestHandler()
		handler.setDiracMessages([{ id: "stream", ts: 1, content: { type: DiracMessageType.MARKDOWN, content: "" } }])

		await handler.appendMarkdownById("stream", "x".repeat(MAX_PENDING_PRESENTATION_PUBLICATION_BYTES + 1))

		expect(handler.hasPresentationPublicationGap()).to.equal(true)
		expect(handler.getPendingPresentationOperations()).to.deep.equal([])
		const snapshot = await handler.capturePresentationSnapshot()
		expect(snapshot.messages[0].content.type).to.equal(DiracMessageType.MARKDOWN)
		if (snapshot.messages[0].content.type !== DiracMessageType.MARKDOWN) throw new Error("Expected markdown")
		expect(snapshot.messages[0].content.content.length).to.equal(MAX_PENDING_PRESENTATION_PUBLICATION_BYTES + 1)
		handler.acknowledgePresentationOperations(snapshot.offset)
		expect(handler.hasPresentationPublicationGap()).to.equal(false)
	})

	it("acknowledges only presentation operations included in a completed publication", async () => {
		const handler = createTestHandler()
		await handler.addToDiracMessages({
			id: "first",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, content: "first" },
		})
		const publishedThrough = handler.getPendingPresentationOperations().at(-1)!.offset
		await handler.addToDiracMessages({
			id: "second",
			ts: 2,
			content: { type: DiracMessageType.MARKDOWN, content: "second" },
		})

		handler.acknowledgePresentationOperations(publishedThrough)

		expect(handler.getPendingPresentationOperations().map((operation) => operation.offset)).to.deep.equal([
			publishedThrough + 1,
		])
	})

	it("maintains the latest API status pointer across deletion and replacement", async () => {
		const handler = createTestHandler()
		handler.setDiracMessages([
			{ id: "first-api", ts: 1, content: { type: DiracMessageType.API_STATUS, status: { request: "first" } } },
			{ id: "markdown", ts: 2, content: { type: DiracMessageType.MARKDOWN, content: "middle" } },
			{ id: "second-api", ts: 3, content: { type: DiracMessageType.API_STATUS, status: { request: "second" } } },
		])

		expect(handler.getLatestApiStatusMessage()?.id).to.equal("second-api")
		await handler.deleteDiracMessage(handler.findMessageIndexById("second-api"))
		expect(handler.getLatestApiStatusMessage()?.id).to.equal("first-api")
		await handler.patchMessageById("first-api", {
			content: { type: DiracMessageType.MARKDOWN, content: "replaced" },
		})
		expect(handler.getLatestApiStatusMessage()).to.equal(undefined)
	})

	it("discards pending and late writes after persistence retirement", async () => {
		const taskId = `retired-task-${++handlerId}`
		const handler = createTestHandler(taskId)
		await handler.addToDiracMessages(createTestMessage("pending"))

		await handler.retirePersistence()
		await handler.addToDiracMessages(createTestMessage("late"))
		await handler.addToApiConversationHistory({ role: "user", content: "late API message" })
		await handler.overwriteApiConversationProviderState({})
		await handler.recordDeliveredSteeringMessageIds(["late-steering-message"])
		await handler.flushPendingWrites()

		expect(handler.getPendingPresentationOperations()).to.deep.equal([])
		expect(fs.existsSync(path.join(tmpDir, "tasks", taskId, "ui_messages.jsonl"))).to.equal(false)
		expect(fs.existsSync(path.join(tmpDir, "tasks", taskId, "api_conversation_history.jsonl"))).to.equal(false)
		expect(fs.existsSync(path.join(tmpDir, "tasks", taskId, "api_conversation_provider_state.json"))).to.equal(false)
	})

})
