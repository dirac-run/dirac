import { strict as assert } from "node:assert"
import { ConversationCondensationService } from "@core/text-condensation/ConversationCondensationService"
import { CardKind, CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { LocalConversationCompaction } from "../LocalConversationCompaction"
import { TaskState } from "../TaskState"

function createMocks() {
	const taskState = new TaskState()
	const selection = {
		provider: "anthropic",
		modelId: "claude-sonnet-4-20250514",
	}
	const card = {
		update: sinon.stub().resolves(),
		appendBody: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub(),
	}
	let providerState: any = {
		checkpoint: { providerId: "active", modelId: "model", input: [] },
	}
	const messageStateHandler = {
		getApiConversationHistory: sinon.stub().returns([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "second" },
			{ role: "user", content: "third" },
		]),
		getDiracMessages: sinon.stub().returns([]),
		getApiConversationProviderState: sinon.stub().callsFake(() => providerState),
		overwriteApiConversationProviderState: sinon.stub().callsFake(async (state: any) => {
			providerState = state
		}),
		saveDiracMessagesAndUpdateHistory: sinon.stub().resolves(),
	}
	const onContextCompacted = sinon.stub()
	const dependencies = {
		taskId: "task-1",
		ulid: "ulid-1",
		taskState,
		messageStateHandler,
		contextManager: {
			getNextTruncationRange: sinon.stub().returns([0, 1]),
		},
		getWorkingConfiguration: sinon.stub().returns({
			settings: {
				utilityModelEnabled: true, utilityModelUseCondense: true, utilityModelUseNewTask: true,
				utilityModelSelection: selection, hooksEnabled: false, mode: "act",
			},
			apiConfiguration: { apiKey: "test-key" },
		}),
		taskMessenger: { createCard: sinon.stub().resolves(card) },
		getApi: sinon.stub().returns({}),
		postStateToWebview: sinon.stub().resolves(),
		cancelTask: sinon.stub().resolves(),
		setActiveHookExecution: sinon.stub().resolves(),
		clearActiveHookExecution: sinon.stub().resolves(),
		onContextCompacted,
	}
	const compaction = new LocalConversationCompaction(dependencies as any)
	return {
		card,
		compaction,
		dependencies,
		messageStateHandler,
		onContextCompacted,
		taskState,
		getProviderState: () => providerState,
	}
}

describe("LocalConversationCompaction", () => {
	afterEach(() => sinon.restore())

	it("preserves a follow-up hidden from effective API history when the Utility summary only mentions the initial task", async () => {
		const { compaction, messageStateHandler } = createMocks()
		messageStateHandler.getDiracMessages.returns([
			{ content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Task A" } },
			{ content: { type: DiracMessageType.CARD, card: { kind: CardKind.TASK_COMPLETION, status: CardStatus.SUCCESS } } },
			{ content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Implement task B" } },
			{ content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Use TypeScript" } },
		])
		const condense = sinon.stub(ConversationCondensationService.prototype, "condenseConversation").resolves("Task A is complete")

		for (let index = 0; index < 2; index++) {
			const continuation = await compaction.run({ source: "automatic" })
			assert.ok(continuation?.includes(JSON.stringify(["Implement task B", "Use TypeScript"])))
			assert.ok(condense.getCall(index).args[1].additionalSourceText?.includes('"Implement task B"'))
		}
	})

	it("includes an incoming follow-up before it is appended to API history without mutating that history", async () => {
		const { compaction, messageStateHandler } = createMocks()
		const apiHistory = messageStateHandler.getApiConversationHistory()
		const originalHistory = structuredClone(apiHistory)
		const condense = sinon.stub(ConversationCondensationService.prototype, "condenseConversation").resolves("Task A is complete")

		const continuation = await compaction.run({
			source: "automatic",
			pendingUserContent: [{ type: "text", text: "<feedback>\nImplement task B\n</feedback>", isUserInput: true }],
		})

		assert.ok(condense.firstCall.args[1].additionalSourceText?.includes('"Implement task B"'))
		assert.ok(continuation?.includes('["Implement task B"]'))
		assert.deepEqual(apiHistory, originalHistory)
	})

	it("silently declines when no Utility model is configured", async () => {
		const { card, compaction, dependencies } = createMocks()
		dependencies.getWorkingConfiguration.returns({ ...dependencies.getWorkingConfiguration(), settings: { ...dependencies.getWorkingConfiguration().settings, utilityModelEnabled: false, utilityModelUseCondense: false } })

		assert.equal(compaction.isAvailable(), false)
		assert.equal(await compaction.run({ source: "automatic" }), undefined)
		assert.equal(dependencies.taskMessenger.createCard.callCount, 0)
		assert.equal(card.finalize.callCount, 0)
	})

	it("returns the committed continuation when success-card presentation fails", async () => {
		expectLoggerErrors()
		const { card, compaction, onContextCompacted, taskState } = createMocks()
		sinon.stub(compaction as any, "generateSummary").resolves("completed summary")
		card.update.rejects(new Error("card update failed"))

		const continuation = await compaction.run({
			source: "automatic",
			triggerApiRequestIndex: 7,
		})

		assert.match(continuation ?? "", /completed summary/)
		assert.deepEqual(taskState.conversationHistoryDeletedRange, [0, 1])
		assert.equal(taskState.lastAutoCondenseTriggerIndex, 7)
		assert.equal(onContextCompacted.callCount, 1)
	})

	it("returns the committed continuation when the compaction observer fails", async () => {
		expectLoggerErrors()
		const { card, compaction, onContextCompacted, taskState } = createMocks()
		sinon.stub(compaction as any, "generateSummary").resolves("completed summary")
		onContextCompacted.throws(new Error("observer failed"))

		const continuation = await compaction.run({ source: "user" })

		assert.match(continuation ?? "", /completed summary/)
		assert.deepEqual(taskState.conversationHistoryDeletedRange, [0, 1])
		assert.ok(card.finalize.calledWith(CardStatus.SUCCESS))
	})

	it("does not compact history when Utility retries are exhausted", async () => {
		expectLoggerErrors()
		const { card, compaction, messageStateHandler, taskState, getProviderState } = createMocks()
		const previousProviderState = getProviderState()
		sinon.stub(compaction as any, "generateSummary").rejects(new Error("final websocket failure"))

		assert.equal(await compaction.run({ source: "automatic" }), undefined)
		assert.equal(messageStateHandler.overwriteApiConversationProviderState.callCount, 0)
		assert.equal(messageStateHandler.saveDiracMessagesAndUpdateHistory.callCount, 0)
		assert.equal(taskState.conversationHistoryDeletedRange, undefined)
		assert.equal(getProviderState(), previousProviderState)
		assert.ok(card.finalize.calledWith(CardStatus.ERROR, true))
		assert.match(card.update.firstCall.args[0].body, /final websocket failure/)
	})

	it("rolls back task and provider state when history persistence fails", async () => {
		const { compaction, messageStateHandler, taskState, getProviderState } = createMocks()
		const previousPending = {
			conversationHistoryDeletedRange: [0, 0] as [number, number],
			previousConversationHistoryDeletedRange: undefined,
		}
		taskState.conversationHistoryDeletedRange = [0, 0]
		taskState.skipNextAutoCondenseCheck = false
		taskState.pendingApiConversationCompaction = previousPending
		taskState.lastAutoCondenseTriggerIndex = 3
		const previousProviderState = getProviderState()
		messageStateHandler.saveDiracMessagesAndUpdateHistory.onFirstCall().rejects(new Error("history save failed"))
		messageStateHandler.saveDiracMessagesAndUpdateHistory.onSecondCall().resolves()

		await assert.rejects((compaction as any).applyCompaction([0, 1], 7), /history save failed/)

		assert.deepEqual(taskState.conversationHistoryDeletedRange, [0, 0])
		assert.equal(taskState.skipNextAutoCondenseCheck, false)
		assert.equal(taskState.pendingApiConversationCompaction, previousPending)
		assert.equal(taskState.lastAutoCondenseTriggerIndex, 3)
		assert.equal(getProviderState(), previousProviderState)
	})

	it("does not commit when cancellation arrives after the PreCompact phase", async () => {
		const { compaction, messageStateHandler, taskState } = createMocks()
		sinon.stub(compaction as any, "generateSummary").resolves("completed summary")
		sinon.stub(compaction as any, "runPreCompactHook").callsFake(async () => {
			taskState.abort = true
			return undefined
		})

		const continuation = await compaction.run({ source: "automatic" })

		assert.equal(continuation, undefined)
		assert.equal(messageStateHandler.overwriteApiConversationProviderState.callCount, 0)
		assert.equal(taskState.conversationHistoryDeletedRange, undefined)
	})
})
