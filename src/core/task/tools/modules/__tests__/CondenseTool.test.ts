import { strict as assert } from "node:assert"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { CondenseTool } from "../condense/CondenseTool"

function createMocks(source: "automatic" | "user" = "automatic") {
	const card = {
		update: sinon.stub().resolves(),
		appendBody: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.APPROVE }),
	}
	const abortController = new AbortController()
	const state: Record<string, unknown> = {
		consecutiveMistakeCount: 0,
		pendingCondenseSource: source === "automatic" ? "automatic" : undefined,
		lastAutoCondenseTriggerIndex: 4,
		abortSignal: abortController.signal,
	}
	let providerState: any = {}
	const conversationCondensation = {
		isAvailable: sinon.stub().returns(false),
		condenseConversation: sinon.stub(),
	}

	const env = {
		ui: { createCard: sinon.stub().resolves(card) },
		conversationCondensation,
		logging: { warn: sinon.stub() },
		orchestration: {
			getCurrentTurnUserRequests: sinon.stub().returns([]),
			getTaskState: sinon.stub().callsFake((key: string) => state[key]),
			setTaskState: sinon.stub().callsFake((key: string, value: unknown) => {
				state[key] = value
			}),
			getNextTruncationRange: sinon.stub().returns([1, 6]),
			setTruncationRange: sinon.stub().callsFake((range: [number, number]) => {
				state.conversationHistoryDeletedRange = range
			}),
			resetTransientState: sinon.stub().resolves(),
			notifyContextCompacted: sinon.stub(),
			runHook: sinon.stub().resolves({}),
		},
		config: {
			isSubagentExecution: false,
			autoApprovalSettings: { enableNotifications: false },
			ulid: "ulid-1",
			mode: "act",
			model: { id: "model-1", info: { contextWindow: 1_000 } },
			taskState: state,
			messageState: {
				getDiracMessages: sinon.stub().returns([]),
				getApiConversationProviderState: sinon.stub().callsFake(() => providerState),
				overwriteApiConversationProviderState: sinon.stub().callsFake(async (state: any) => {
					providerState = state
				}),
				saveDiracMessagesAndUpdateHistory: sinon.stub().resolves(),
			},
			services: {
				contextManager: {
					getContextTelemetryData: sinon.stub().returns({ tokensUsed: 750, maxContextWindow: 1000 }),
				},
			},
		},
	}
	return { card, env, state, abortController, conversationCondensation, getProviderState: () => providerState }
}

describe("CondenseTool", () => {
	afterEach(() => sinon.restore())

	it("preserves current intent independently of stale active-model summaries across repeated condensations", async () => {
		const { env, state } = createMocks("automatic")
		const requests = ["Implement task B", "Use TypeScript"]
		env.orchestration.getCurrentTurnUserRequests.returns(requests)

		for (let index = 0; index < 2; index++) {
			state.pendingCondenseSource = "automatic"
			const result = await new CondenseTool().processCall({ context: "Task A is complete" }, env as any)
			assert.ok(result.indexOf(JSON.stringify(requests)) > result.indexOf("Task A is complete"))
		}
		assert.equal(env.orchestration.getCurrentTurnUserRequests.callCount, 2)
	})

	it("includes original current-turn requests in Utility input and output even if its summary omits them", async () => {
		const { env, conversationCondensation } = createMocks("automatic")
		const requests = ["Implement task B", "Use TypeScript"]
		env.orchestration.getCurrentTurnUserRequests.returns(requests)
		conversationCondensation.isAvailable.returns(true)
		conversationCondensation.condenseConversation.resolves({
			text: "Task A is complete",
			modelIdentity: { providerId: "openai", modelId: "utility-model" },
		})

		const result = await new CondenseTool().processCall({}, env as any)
		const options = conversationCondensation.condenseConversation.firstCall.args[1]
		assert.ok(options.additionalSourceText.includes(JSON.stringify(requests)))
		assert.ok(result.includes(JSON.stringify(requests)))
	})

	it("automatically condenses without waiting for user approval", async () => {
		const { card, env, state, getProviderState } = createMocks("automatic")

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(card.waitForInteraction.callCount, 0)
		assert.deepEqual(env.orchestration.setTruncationRange.firstCall.args[0], [1, 6])
		assert.equal(state.skipNextAutoCondenseCheck, true)
		assert.deepEqual(state.pendingApiConversationCompaction, {
			conversationHistoryDeletedRange: [1, 6],
			previousConversationHistoryDeletedRange: undefined,
		})
		assert.deepEqual(getProviderState().pendingCompaction, {
			conversationHistoryDeletedRange: [1, 6],
			previousConversationHistoryDeletedRange: undefined,
		})
		assert.match(result, /Please continue the conversation/)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 1)
		assert.ok(env.orchestration.notifyContextCompacted.calledAfter(card.finalize))
	})

	it("uses the Utility model for a no-context automatic condense before consuming source state", async () => {
		const { card, env, state, conversationCondensation } = createMocks("automatic")
		conversationCondensation.isAvailable.returns(true)
		conversationCondensation.condenseConversation.resolves({
			text: "utility summary",
			modelIdentity: { providerId: "openai", modelId: "utility-model" },
		})

		const result = await new CondenseTool().processCall({}, env as any)

		assert.equal(conversationCondensation.condenseConversation.callCount, 1)
		assert.ok(
			conversationCondensation.condenseConversation.calledWithMatch(
				"conversation_continuation",
				sinon.match({ historyScope: "effective" }),
			),
		)
		assert.equal(state.pendingCondenseSource, undefined)
		assert.equal(card.waitForInteraction.callCount, 0)
		assert.deepEqual(env.orchestration.setTruncationRange.firstCall.args[0], [1, 6])
		assert.match(result, /utility summary/)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 1)
	})

	it("returns active-model fallback instructions without mutating failed automatic condensation", async () => {
		const { card, env, state, conversationCondensation } = createMocks("automatic")
		conversationCondensation.isAvailable.returns(true)
		conversationCondensation.condenseConversation.rejects(new Error("utility unavailable"))

		const fallback = await new CondenseTool().processCall({}, env as any)

		assert.equal(state.pendingCondenseSource, "automatic")
		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.equal(card.waitForInteraction.callCount, 0)
		assert.match(fallback, /Do not call it again without context/)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 0)

		await new CondenseTool().processCall({ context: "active model summary" }, env as any)
		assert.equal(card.waitForInteraction.callCount, 0)
		assert.equal(state.pendingCondenseSource, undefined)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 1)
	})

	it("propagates task cancellation without fallback or compaction mutation", async () => {
		const { abortController, env, state, conversationCondensation } = createMocks("automatic")
		conversationCondensation.isAvailable.returns(true)
		conversationCondensation.condenseConversation.callsFake(async (_template: string, options: { signal?: AbortSignal }) => {
			assert.equal(options.signal, abortController.signal)
			abortController.abort()
			throw new Error("cancelled")
		})

		await assert.rejects(new CondenseTool().processCall({}, env as any), /cancelled/)

		assert.equal(state.pendingCondenseSource, "automatic")
		assert.equal(env.logging.warn.callCount, 0)
		assert.equal(env.ui.createCard.callCount, 0)
		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.equal(state.pendingApiConversationCompaction, undefined)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 0)
	})

	it("preserves the active task after an approved manual compaction", async () => {
		const { env, card } = createMocks("user")
		env.orchestration.getCurrentTurnUserRequests.returns(["Implement task B", "Use TypeScript"])

		const result = await new CondenseTool().processCall({ context: "Task A is complete" }, env as any)

		assert.equal(card.waitForInteraction.callCount, 1)
		assert.ok(result.includes('["Implement task B","Use TypeScript"]'))
		assert.ok(result.includes('do not ask the user to repeat them'))
	})

	it("runs the hook before applying an approved user condense", async () => {
		const { card, env } = createMocks("user")

		await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(card.waitForInteraction.callCount, 1)
		assert.ok(env.orchestration.runHook.calledBefore(env.orchestration.setTruncationRange))
		assert.ok(card.finalize.calledWith("success"))
	})

	it("does not compact when the user rejects the summary", async () => {
		const { card, env, state } = createMocks("user")
		card.waitForInteraction.resolves({ action: DiracAskResponse.REJECT, text: "include the latest changes" })

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(env.orchestration.runHook.callCount, 0)
		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.equal(state.pendingApiConversationCompaction, undefined)
		assert.match(result, /include the latest changes/)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 0)
	})

	it("does not mutate truncation state when the hook cancels", async () => {
		const { env, state } = createMocks("automatic")
		env.orchestration.runHook.resolves({ cancel: true })

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.equal(state.pendingApiConversationCompaction, undefined)
		assert.match(result, /cancelled by PreCompact hook/)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 0)
	})

	it("includes hook context modifications in the continuation", async () => {
		const { env } = createMocks("automatic")
		env.orchestration.runHook.resolves({ contextModification: "retain deployment constraints" })

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.match(result, /retain deployment constraints/)
	})
	it("does not compact when the task is cancelled after approval", async () => {
		const { abortController, card, env, state } = createMocks("user")
		card.waitForInteraction.callsFake(async () => {
			abortController.abort()
			return { action: DiracAskResponse.APPROVE }
		})

		await assert.rejects(new CondenseTool().processCall({ context: "summary" }, env as any), /Task instance aborted/)

		assert.equal(env.orchestration.runHook.callCount, 0)
		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.equal(state.pendingApiConversationCompaction, undefined)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 0)
	})

	it("does not compact when the task is cancelled by the PreCompact phase", async () => {
		const { abortController, env, state } = createMocks("automatic")
		env.orchestration.runHook.callsFake(async () => {
			abortController.abort()
			return {}
		})

		await assert.rejects(new CondenseTool().processCall({ context: "summary" }, env as any), /Task instance aborted/)

		assert.equal(env.orchestration.setTruncationRange.callCount, 0)
		assert.equal(state.pendingApiConversationCompaction, undefined)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 0)
	})

	it("rolls back task and provider state when compaction history persistence fails", async () => {
		const { env, state, getProviderState } = createMocks("automatic")
		const previousPendingCompaction = {
			conversationHistoryDeletedRange: [0, 2],
			previousConversationHistoryDeletedRange: undefined,
		}
		state.conversationHistoryDeletedRange = [0, 2]
		state.skipNextAutoCondenseCheck = false
		state.pendingApiConversationCompaction = previousPendingCompaction
		env.config.messageState.saveDiracMessagesAndUpdateHistory.onFirstCall().rejects(new Error("history save failed"))
		env.config.messageState.saveDiracMessagesAndUpdateHistory.onSecondCall().resolves()

		await assert.rejects(new CondenseTool().processCall({ context: "summary" }, env as any), /history save failed/)

		assert.deepEqual(state.conversationHistoryDeletedRange, [0, 2])
		assert.equal(state.skipNextAutoCondenseCheck, false)
		assert.equal(state.pendingApiConversationCompaction, previousPendingCompaction)
		assert.deepEqual(getProviderState(), {})
		assert.equal(env.orchestration.resetTransientState.callCount, 0)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 0)
	})

	it("returns the committed continuation when post-compaction presentation fails", async () => {
		const { env, state } = createMocks("automatic")
		env.ui.createCard.rejects(new Error("card unavailable"))

		const result = await new CondenseTool().processCall({ context: "summary" }, env as any)

		assert.match(result, /Please continue the conversation/)
		assert.deepEqual(state.conversationHistoryDeletedRange, [1, 6])
		assert.equal(env.logging.warn.callCount, 1)
		assert.equal(env.orchestration.notifyContextCompacted.callCount, 1)
	})
})
