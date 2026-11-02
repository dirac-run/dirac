import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { ApiConversationProviderState } from "@core/api/conversation"
import type { DiracStorageMessage, DiracTextContentBlock } from "@shared/messages/content"
import { ApiConversationManager } from "../ApiConversationManager"
import { Task } from "../index"
import { TaskState } from "../TaskState"

const deliver = (Task.prototype as unknown as {
	deliverTaskletEvents: (history: DiracStorageMessage[]) => Promise<void>
}).deliverTaskletEvents

function fixture() {
	const history: DiracStorageMessage[] = [{ role: "user", content: [{ type: "text", text: "original assignment" }] }]
	let providerState: ApiConversationProviderState = {}
	let pending = true
	const block: DiracTextContentBlock = { type: "text", text: "NEW CHILD QUESTION", taskletEventIds: ["event-1"] }
	const flush = sinon.stub().resolves()
	const acknowledge = sinon.stub().callsFake(async () => { pending = false })
	const messageStateHandler = {
		getApiConversationHistory: () => history,
		getApiConversationProviderState: () => providerState,
		overwriteApiConversationProviderState: async (state: ApiConversationProviderState) => { providerState = state },
		addToApiConversationHistory: sinon.stub().callsFake(async (message: DiracStorageMessage) => { history.push(structuredClone(message)) }),
		appendToLastApiConversationUserMessage: sinon.stub().callsFake(async (content: DiracTextContentBlock) => {
			const message = history.at(-1)!
			assert.ok(Array.isArray(message.content))
			message.content.push(content)
			return message
		}),
		flushPendingWrites: flush,
		saveDiracMessagesAndUpdateHistory: sinon.stub().resolves(),
	}
	const root = {
		messageStateHandler,
		taskletHost: { prepareEventDelivery: async () => pending ? { content: [block], acknowledge } : undefined },
	}
	const taskState = new TaskState()
	taskState.conversationHistoryDeletedRange = [0, 0]
	const compactConversation = sinon.stub().resolves({ input: [{ type: "opaque-reasoning", encrypted: "preserve-me" }] })
	const manager = new ApiConversationManager({
		taskState,
		messageStateHandler,
		getRequestRuntime: () => undefined,
		api: { compactConversation },
		contextManager: { getTruncatedMessages: () => history },
	} as unknown as ConstructorParameters<typeof ApiConversationManager>[0])
	const dispatch = (truncatedMessages = history) => manager.prepareProviderConversationDispatch({
		systemPrompt: "supervise", tools: [], truncatedMessages, providerId: "provider", modelId: "model",
	})
	return {
		history, root, manager, dispatch, flush, acknowledge, compactConversation, messageStateHandler,
		providerState: () => providerState,
		deliver: (outbound: DiracStorageMessage[]) => deliver.call(root, outbound),
	}
}

describe("Tasklet delivery after native compaction", () => {
	for (const sharedHistory of [true, false]) {
		it(`preserves the checkpoint and delivers a new question after a pre-output failure (${sharedHistory ? "shared" : "copied"} history)`, async () => {
			const test = fixture()
			await test.manager.scheduleProviderConversationCompaction(undefined, [0, 0])
			const first = await test.dispatch()
			assert.deepEqual(first.messages, [])
			const checkpoint = structuredClone(first.options.checkpoint)
			// The first provider request fails before output: no assistant message is appended.
			const outbound = sharedHistory ? test.history : structuredClone(test.history)
			await test.deliver(outbound)
			assert.equal(test.history.length, 2)
			assert.equal(JSON.stringify(test.history[0]).includes("NEW CHILD QUESTION"), false)
			const retry = await test.dispatch(outbound)
			assert.deepEqual(retry.options.checkpoint, checkpoint)
			assert.equal(retry.messages.length, 1)
			assert.match(JSON.stringify(retry.messages), /NEW CHILD QUESTION/)
			assert.equal(outbound.length, 2)
			sinon.assert.calledOnce(test.compactConversation)
			sinon.assert.callOrder(test.flush, test.acknowledge)
			sinon.assert.calledOnce(test.messageStateHandler.addToApiConversationHistory)
			sinon.assert.notCalled(test.messageStateHandler.appendToLastApiConversationUserMessage)
		})
	}

	it("retries a failed parent flush without duplicating a post-checkpoint message", async () => {
		const test = fixture()
		await test.manager.scheduleProviderConversationCompaction(undefined, [0, 0])
		await test.dispatch()
		const checkpoint = structuredClone(test.providerState().checkpoint)
		const outbound = structuredClone(test.history)
		test.flush.onFirstCall().rejects(new Error("disk unavailable"))
		await assert.rejects(test.deliver(outbound), /disk unavailable/)
		sinon.assert.notCalled(test.acknowledge)
		await test.deliver(outbound)
		assert.equal(test.history.length, 2)
		assert.equal(outbound.length, 2)
		sinon.assert.calledOnce(test.messageStateHandler.addToApiConversationHistory)
		const retry = await test.dispatch(outbound)
		assert.deepEqual(retry.options.checkpoint, checkpoint)
		assert.equal(JSON.stringify(retry.messages).split("NEW CHILD QUESTION").length - 1, 1)
	})

	it("does not duplicate an event already incorporated into an opaque checkpoint on receipt retry", async () => {
		const test = fixture()
		test.acknowledge.onFirstCall().rejects(new Error("receipt unavailable"))
		await assert.rejects(test.deliver(test.history), /receipt unavailable/)
		await test.manager.scheduleProviderConversationCompaction(undefined, [0, 0])
		const compacted = await test.dispatch()
		const checkpoint = structuredClone(compacted.options.checkpoint)
		await test.deliver(structuredClone(test.history))
		assert.equal(test.history.length, 1)
		assert.equal(JSON.stringify(test.history).split("NEW CHILD QUESTION").length - 1, 1)
		const retry = await test.dispatch()
		assert.deepEqual(retry.messages, [])
		assert.deepEqual(retry.options.checkpoint, checkpoint)
		sinon.assert.notCalled(test.messageStateHandler.addToApiConversationHistory)
	})
})
