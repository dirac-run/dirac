import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { ApiConversationProviderState } from "@core/api/conversation"
import type { DiracStorageMessage, DiracTextContentBlock } from "@shared/messages/content"
import { ApiConversationManager } from "../ApiConversationManager"
import { materializeModelBoundInput } from "../TaskInputMaterialization"
import { TaskState } from "../TaskState"

type IdentityField = "steeringMessageIds" | "taskletEventIds" | "agentMessageIds" | "journalNotificationIds"

function fixture(identityField: IdentityField) {
	const toolCall: DiracStorageMessage = {
		role: "assistant",
		content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "source.ts" } }],
	}
	const toolResult: DiracStorageMessage = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "call-1", content: "source contents" }],
	}
	const history: DiracStorageMessage[] = [{ role: "user", content: "assignment" }, toolCall, toolResult]
	let providerState: ApiConversationProviderState = {}
	const block: DiracTextContentBlock = { type: "text", text: "NEW INPUT", [identityField]: ["input-1"] }
	const acknowledge = sinon.stub().resolves()
	const flush = sinon.stub().resolves()
	const messageState = {
		getApiConversationHistory: () => history,
		getApiConversationProviderState: () => providerState,
		overwriteApiConversationProviderState: async (state: ApiConversationProviderState) => {
			providerState = state
		},
		addToApiConversationHistory: sinon.stub().callsFake(async (message: DiracStorageMessage) => {
			history.push(structuredClone(message))
		}),
		appendToLastApiConversationUserMessage: sinon.stub().callsFake(async (content: DiracTextContentBlock) => {
			const message = history.at(-1)!
			if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }, content]
			else message.content.push(content)
			return message
		}),
		flushPendingWrites: flush,
		saveDiracMessagesAndUpdateHistory: sinon.stub().resolves(),
	}
	const taskState = new TaskState()
	taskState.conversationHistoryDeletedRange = [0, 0]
	const compactConversation = sinon.stub().resolves({ input: [{ type: "opaque-reasoning", encrypted: "preserve-me" }] })
	const manager = new ApiConversationManager({
		taskState,
		messageStateHandler: messageState,
		getRequestRuntime: () => undefined,
		api: { compactConversation },
		contextManager: { getTruncatedMessages: () => history },
	} as unknown as ConstructorParameters<typeof ApiConversationManager>[0])
	const dispatch = (outbound = history) =>
		manager.prepareProviderConversationDispatch({
			systemPrompt: "work",
			tools: [],
			truncatedMessages: outbound,
			providerId: "provider",
			modelId: "model",
		})
	return {
		history,
		block,
		acknowledge,
		flush,
		messageState,
		toolCall,
		toolResult,
		compactConversation,
		providerState: () => providerState,
		dispatch,
		compact: async () => {
			await manager.scheduleProviderConversationCompaction(undefined, [0, 0])
			return dispatch()
		},
		materialize: (outbound: DiracStorageMessage[], content = [block]) =>
			materializeModelBoundInput(messageState, outbound, content, identityField, acknowledge),
	}
}

function occurrences(value: unknown, text: string): number {
	return JSON.stringify(value).split(text).length - 1
}

describe("Checkpoint-aware model input materialization", () => {
	for (const identityField of ["steeringMessageIds", "taskletEventIds", "agentMessageIds", "journalNotificationIds"] as const) {
		describe(identityField, () => {
			for (const projection of ["shared", "copied", "shallow"] as const) {
				it(`puts retry-time input after an unchanged opaque checkpoint (${projection} projection)`, async () => {
					const test = fixture(identityField)
					const coveredHistory = structuredClone(test.history)
					const first = await test.compact()
					assert.deepEqual(first.messages, [])
					const checkpoint = structuredClone(first.options.checkpoint)
					// The request failed before output; no assistant turn was added after compaction.
					const outbound =
						projection === "shared"
							? test.history
							: projection === "copied"
								? structuredClone(test.history)
								: [...test.history]

					await test.materialize(outbound)

					assert.deepEqual(test.history.slice(0, coveredHistory.length), coveredHistory)
					assert.deepEqual(outbound.slice(0, coveredHistory.length), coveredHistory)
					assert.equal(test.history.length, 4)
					assert.equal(outbound.length, 4)
					const retry = await test.dispatch(outbound)
					assert.deepEqual(retry.options.checkpoint, checkpoint)
					assert.equal(retry.messages.length, 1)
					assert.equal(occurrences(retry.messages, "NEW INPUT"), 1)
					sinon.assert.calledOnce(test.compactConversation)
					sinon.assert.calledOnce(test.messageState.addToApiConversationHistory)
					sinon.assert.notCalled(test.messageState.appendToLastApiConversationUserMessage)
					sinon.assert.callOrder(test.flush, test.acknowledge)
				})
			}

			it("keeps tool calls/results paired and does not duplicate blocks in a shared content array", async () => {
				const test = fixture(identityField)
				const outbound = test.history.map((message) => ({ ...message }))
				await test.materialize(outbound)
				assert.equal(test.history[1], test.toolCall)
				assert.equal(test.history[2], test.toolResult)
				assert.deepEqual((test.toolResult.content as any[])[0], {
					type: "tool_result",
					tool_use_id: "call-1",
					content: "source contents",
				})
				assert.equal(test.history.length, 3)
				assert.equal(outbound.length, 3)
				assert.equal(occurrences(test.history, "NEW INPUT"), 1)
				assert.equal(occurrences(outbound, "NEW INPUT"), 1)
				sinon.assert.calledOnce(test.messageState.appendToLastApiConversationUserMessage)
				sinon.assert.notCalled(test.messageState.addToApiConversationHistory)
			})

			for (const failure of ["flush", "receipt"] as const) {
				it(`retries a failed ${failure} with stable identities and also accepts newly arrived input`, async () => {
					const test = fixture(identityField)
					await test.compact()
					const checkpoint = structuredClone(test.providerState().checkpoint)
					const outbound = structuredClone(test.history)
					const failedOperation = failure === "flush" ? test.flush : test.acknowledge
					failedOperation.onFirstCall().rejects(new Error(`${failure} unavailable`))
					await assert.rejects(test.materialize(outbound), /unavailable/)
					if (failure === "flush") sinon.assert.notCalled(test.acknowledge)
					const later: DiracTextContentBlock = { type: "text", text: "LATER INPUT", [identityField]: ["input-2"] }

					await test.materialize(outbound, [test.block, later])

					assert.equal(occurrences(test.history, "NEW INPUT"), 1)
					assert.equal(occurrences(outbound, "NEW INPUT"), 1)
					const retry = await test.dispatch(outbound)
					assert.deepEqual(retry.options.checkpoint, checkpoint)
					assert.equal(occurrences(retry.messages, "NEW INPUT"), 1)
					assert.equal(occurrences(retry.messages, "LATER INPUT"), 1)
					sinon.assert.calledOnce(test.messageState.addToApiConversationHistory)
					sinon.assert.calledOnce(test.messageState.appendToLastApiConversationUserMessage)
					sinon.assert.calledTwice(test.flush)
				})
			}

			it("reconciles a write that staged a post-checkpoint turn before rejecting", async () => {
				const test = fixture(identityField)
				await test.compact()
				const coveredHistory = structuredClone(test.history)
				const outbound = structuredClone(test.history)
				test.messageState.addToApiConversationHistory.onFirstCall().callsFake(async (message: DiracStorageMessage) => {
					test.history.push(structuredClone(message))
					throw new Error("write acknowledgement lost")
				})
				await assert.rejects(test.materialize(outbound), /write acknowledgement lost/)
				sinon.assert.notCalled(test.acknowledge)
				await test.materialize(outbound)
				assert.deepEqual(test.history.slice(0, coveredHistory.length), coveredHistory)
				assert.deepEqual(outbound.slice(0, coveredHistory.length), coveredHistory)
				assert.equal(occurrences(test.history, "NEW INPUT"), 1)
				assert.equal(occurrences(outbound, "NEW INPUT"), 1)
				sinon.assert.calledOnce(test.messageState.addToApiConversationHistory)
				sinon.assert.calledOnce(test.acknowledge)
			})

			it("does not replay checkpoint-covered input when retrying its receipt", async () => {
				const test = fixture(identityField)
				test.acknowledge.onFirstCall().rejects(new Error("receipt unavailable"))
				await assert.rejects(test.materialize(test.history), /receipt unavailable/)
				const compacted = await test.compact()
				const coveredHistory = structuredClone(test.history)
				const outbound = structuredClone(test.history)

				await test.materialize(outbound)

				assert.deepEqual(test.history, coveredHistory)
				assert.deepEqual(outbound, coveredHistory)
				const retry = await test.dispatch(outbound)
				assert.deepEqual(retry.messages, [])
				assert.deepEqual(retry.options.checkpoint, compacted.options.checkpoint)
				sinon.assert.calledOnce(test.messageState.appendToLastApiConversationUserMessage)
				sinon.assert.notCalled(test.messageState.addToApiConversationHistory)
				sinon.assert.calledTwice(test.acknowledge)
			})

			it("deduplicates pending input after reopening from durable history", async () => {
				const test = fixture(identityField)
				await test.materialize(test.history)
				const reopenedHistory = structuredClone(test.history)
				const reopenedState = { ...test.messageState, getApiConversationHistory: () => reopenedHistory }
				const acknowledge = sinon.stub().resolves()
				await materializeModelBoundInput(reopenedState, reopenedHistory, [test.block], identityField, acknowledge)
				assert.equal(occurrences(reopenedHistory, "NEW INPUT"), 1)
				sinon.assert.calledOnce(test.messageState.appendToLastApiConversationUserMessage)
				sinon.assert.calledOnce(acknowledge)
			})
		})
	}

	it("does not confuse steering and tasklet identities with the same value", async () => {
		const test = fixture("steeringMessageIds")
		;(test.history.at(-1)!.content as DiracTextContentBlock[]).push({
			type: "text",
			text: "child message",
			taskletEventIds: ["input-1"],
		})
		await test.materialize(test.history, [test.block, test.block])
		assert.equal(occurrences(test.history, "NEW INPUT"), 1)
		assert.equal(occurrences(test.history, "child message"), 1)
		sinon.assert.calledOnce(test.messageState.appendToLastApiConversationUserMessage)
	})
})
