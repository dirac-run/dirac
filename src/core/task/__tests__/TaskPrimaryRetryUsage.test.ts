import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DiracError } from "@services/error"
import { DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { DiracAskResponse } from "@shared/WebviewMessage"
import * as retryPolicy from "@core/api/ApiRequestRetryPolicy"
import { StreamingMetricsManager } from "../StreamingMetricsManager"
import { attemptApiRequest } from "../TaskApiRequestAttempt"
import * as requestBuilder from "../TaskRequestBuilder"
import { handleApiRequestError } from "../TaskRequestOutcome"
import { TaskState } from "../TaskState"
import * as steering from "../TaskSteering"

/** Real attempt/recovery/metrics logic; controlled provider and in-memory presentation patches. */
describe("primary retry usage attribution", () => {
	function fixture(priced: boolean, failedAttempts = 1) {
		const message: DiracMessage = { id: "request", ts: 1, content: { type: DiracMessageType.API_STATUS, status: {} } }
		const observations: number[] = []
		const messages = {
			getDiracMessages: () => [message], getLatestApiStatusMessage: () => message,
			findMessageIndexById: () => 0,
			patchApiStatusById: async (_id: string, patch: object, deletions: string[] = []) => {
				assert.equal(message.content.type, DiracMessageType.API_STATUS)
				Object.assign((message.content as any).status, patch)
				for (const key of deletions) delete (message.content as any).status[key]
				observations.push(getApiMetrics([message]).totalTokensIn)
			},
			updateDiracMessage: async () => { }, saveDiracMessagesAndUpdateHistory: async () => { },
		}
		let attempts = 0
		const api = {
			getModel: () => ({ id: "controlled", info: { contextWindow: 1000 } }),
			shouldEstimateCost: () => false,
			async *createMessage() {
				attempts++
				yield {
					type: "usage", inputTokens: attempts === 1 ? 100 : 60, outputTokens: 10,
					reasoningTokens: 3, cacheWriteTokens: 2, cacheReadTokens: 4,
					...(priced ? { totalCost: attempts === 1 ? 0.5 : 0.25 } : {})
				}
				if (attempts <= failedAttempts) throw new Error("transport failed")
				yield { type: "text", text: "success" }
			},
		}
		const ctx = {
			taskState: new TaskState(), messageStateHandler: messages, requestRuntime: { api }, api,
			executionProfile: "tasklet", postStateToWebview: async () => { },
			apiConversationManager: { prepareProviderConversationDispatch: async () => ({ messages: [], options: {} }) },
			taskMessenger: {
				upsertText: async () => { }, createCard: async () => ({ update: async () => { }, finalize: async () => { }, waitForInteraction: async () => ({ response: DiracAskResponse.APPROVE }) }),
			},
			abortTask: async () => { ctx.taskState.abort = true },
		} as any
		return { ctx, api, message, messages, observations, attempts: () => attempts }
	}

	for (const priced of [true, false]) {
		it(`retains ${priced ? "priced" : "unknown-priced"} first-chunk usage through hidden retry and finalization`, async () => {
			const sandbox = sinon.createSandbox()
			try {
				sandbox.stub(requestBuilder, "buildApiRequestParams").resolves({ systemPrompt: "system", toolSnapshot: { nativeTools: [] }, contextManagementMetadata: { truncatedConversationHistory: [] }, providerInfo: { providerId: "anthropic", model: { id: "controlled", info: {} }, mode: "act" } } as any)
				sandbox.stub(steering, "appendQueuedSteeringToNextApiRequest").resolves()
				sandbox.stub(DiracError, "transform").returns({ isErrorType: () => false, serialize: () => "transport", toDisplayMessage: () => "transport" } as any)
				sandbox.stub(retryPolicy, "getApiRequestRetryDelay").returns(0)
				const f = fixture(priced)
				const manager = new StreamingMetricsManager(f.messages as any, 0, f.api as any)
				const chunks = []
				for await (const chunk of attemptApiRequest(f.ctx, -1, 0, false, manager)) chunks.push(chunk)
				assert.equal(f.attempts(), 2)
				assert.equal(chunks.length, 3)
				await manager.updateApiReqMsgFromMetrics()
				await manager.updateApiReqMsgFromMetrics()
				const metrics = getApiMetrics([f.message])
				assert.equal(metrics.totalTokensIn, 160)
				assert.equal(metrics.totalTokensOut, 20)
				assert.equal(metrics.totalReasoningTokens, 6)
				assert.equal(metrics.totalCacheWrites, 4)
				assert.equal(metrics.totalCacheReads, 8)
				assert.equal(metrics.totalCost, priced ? 0.75 : 0)
				assert.equal(getLastApiReqTotalTokens([f.message]), 76)
				assert.ok(f.observations.every((tokens) => tokens === 100 || tokens === 160), JSON.stringify(f.observations))
				if (!priced) assert.equal((f.message.content as any).status.cost, undefined)
			} finally { sandbox.restore() }
		})
	}

	it("archives multiple failed attempts once while draining delayed outer usage writes", async () => {
		const sandbox = sinon.createSandbox()
		try {
			sandbox.stub(requestBuilder, "buildApiRequestParams").resolves({ systemPrompt: "system", toolSnapshot: { nativeTools: [] }, contextManagementMetadata: { truncatedConversationHistory: [] }, providerInfo: { providerId: "anthropic", model: { id: "controlled", info: {} }, mode: "act" } } as any)
			sandbox.stub(steering, "appendQueuedSteeringToNextApiRequest").resolves()
			sandbox.stub(DiracError, "transform").returns({ isErrorType: () => false, serialize: () => "transport", toDisplayMessage: () => "transport" } as any)
			sandbox.stub(retryPolicy, "getApiRequestRetryDelay").returns(0)
			const f = fixture(true, 2)
			const manager = new StreamingMetricsManager(f.messages as any, 0, f.api as any)
			let queued: Promise<void> = Promise.resolve()
			let drains = 0
			for await (const chunk of attemptApiRequest(f.ctx, -1, 0, false, manager, async () => { drains++; await queued })) {
				if (chunk.type === "usage") queued = queued.then(async () => {
					await new Promise((resolve) => setTimeout(resolve, 2))
					await manager.updateApiReqMsgFromMetrics()
				})
			}
			await queued
			await manager.updateApiReqMsgFromMetrics()
			assert.equal(f.attempts(), 3)
			assert.equal(drains, 2)
			assert.equal(getApiMetrics([f.message]).totalTokensIn, 220)
			assert.equal(getApiMetrics([f.message]).totalCost, 1)
			assert.deepEqual((f.message.content as any).status.deletedMetrics, {
				tokensIn: 160, tokensOut: 20, cacheWrites: 4, cacheReads: 8, cost: 0.75, reasoningTokens: 6,
			})
		} finally { sandbox.restore() }
	})

	it("keeps observed usage live while awaiting a manual decision and when cancelled", async () => {
		const sandbox = sinon.createSandbox()
		try {
			sandbox.stub(DiracError, "transform").returns({ isErrorType: (type: string) => type === "auth", serialize: () => "auth", toDisplayMessage: () => "auth" } as any)
			const f = fixture(false)
			const manager = new StreamingMetricsManager(f.messages as any, 0, f.api as any)
			manager.updateFromChunk({ inputTokens: 100, outputTokens: 10, reasoningTokens: 3 })
			f.ctx.taskMessenger.createCard = async () => ({
				finalize: async () => { }, waitForInteraction: async () => {
					assert.equal(getApiMetrics([f.message]).totalTokensIn, 100)
					assert.equal((f.message.content as any).status.deletedMetrics, undefined)
					return { response: DiracAskResponse.REJECT }
				}
			})
			assert.equal(await handleApiRequestError(f.ctx, { error: new Error("auth"), previousApiReqIndex: -1, lastApiReqIndex: 0, model: { id: "controlled", info: {} }, providerId: "anthropic", metricsManager: manager }), false)
			assert.equal(getApiMetrics([f.message]).totalTokensIn, 100)
			assert.equal(f.ctx.taskState.abort, true)
		} finally { sandbox.restore() }
	})
})
