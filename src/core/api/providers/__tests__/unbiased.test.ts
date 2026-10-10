import assert from "node:assert/strict"
import { StateManager } from "@core/storage/StateManager"
import { unbiasedModels } from "@shared/api"
import type { GlobalState } from "@shared/storage/state-keys"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { saveUnbiasedOAuthAccount } from "@/integrations/unbiased/oauth-account"
import { calculateApiCostAnthropic } from "@/utils/cost"
import { buildApiHandler, buildApiHandlerForSelection } from "../../index"
import type { ApiStreamUsageChunk } from "../../transform/stream"
import * as unbiasedCatalog from "../../unbiased/unbiased-models"
import { UnbiasedHandler } from "../unbiased"

const emptyStream = { [Symbol.asyncIterator]: async function* () {} }

describe("Unbiased request parameters", () => {
	it("sends the model's maximum output tokens", async () => {
		const handler = new UnbiasedHandler({ unbiasedApiKey: "test-key" })
		const create = (params: { max_tokens?: number }) => {
			assert.equal(params.max_tokens, 131_072)
			return Promise.resolve(emptyStream)
		}
		Object.defineProperty(handler, "client", { value: { chat: { completions: { create } } } })

		for await (const _chunk of handler.createMessage("system", [])) {
			// Consume the empty response.
		}
	})
})

describe("Unbiased request cancellation", () => {
	it("aborts an in-flight request and allows the next request to proceed", async () => {
		const handler = new UnbiasedHandler({ unbiasedApiKey: "test-key" })
		const signals: AbortSignal[] = []
		let requestStarted!: () => void
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve
		})
		const create = (_params: unknown, options: { signal: AbortSignal }) => {
			signals.push(options.signal)
			if (signals.length > 1) return Promise.resolve(emptyStream)
			requestStarted()
			return new Promise<never>((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true })
			})
		}
		Object.defineProperty(handler, "client", { value: { chat: { completions: { create } } } })

		const first = handler.createMessage("system", []).next()
		await started
		assert.equal(signals[0].aborted, false)
		handler.abort()
		await assert.rejects(first, /request aborted/)
		assert.equal(signals[0].aborted, true)

		for await (const _chunk of handler.createMessage("system", [])) {
			// Consume the next empty response.
		}
		assert.equal(signals.length, 2)
		assert.equal(signals[1].aborted, false)
	})
})

describe("Unbiased authentication-specific pricing", () => {
	const oauthKey = "private-oauth-key"
	let globalState: Partial<GlobalState>
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		globalState = {}
		const stateManager = {
			getGlobalStateKey: (key: keyof GlobalState) => globalState[key],
			getModelsCache: () => null,
			setGlobalStateBatch: (updates: Partial<GlobalState>) => Object.assign(globalState, updates),
		} as unknown as StateManager
		sandbox.stub(StateManager, "isInitialized").returns(true)
		sandbox.stub(StateManager, "get").returns(stateManager)
		saveUnbiasedOAuthAccount(stateManager, {
			accessToken: oauthKey,
			organizationId: "organization",
			workloadId: "workload",
			workloadName: "Dirac workload",
			keyName: "Dirac key",
		})
	})

	afterEach(() => sandbox.restore())

	async function requestUsage(handler: UnbiasedHandler, cost?: number): Promise<ApiStreamUsageChunk> {
		const stream = {
			[Symbol.asyncIterator]: async function* () {
				yield {
					choices: [],
					usage: {
						prompt_tokens: 1_000,
						completion_tokens: 500,
						prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
						cost,
					},
				}
			},
		}
		Object.defineProperty(handler, "client", { value: { chat: { completions: { create: async () => stream } } } })
		const usages: ApiStreamUsageChunk[] = []
		for await (const chunk of handler.createMessage("system", [])) {
			if (chunk.type === "usage") usages.push(chunk)
		}
		assert.equal(usages.length, 1)
		return usages[0]
	}

	for (const reportedCost of [undefined, 4.2]) {
		it(`records zero subscription cost with provider cost ${reportedCost}, preserving token usage`, async () => {
			const handler = new UnbiasedHandler({ unbiasedApiKey: oauthKey })
			const usage = await requestUsage(handler, reportedCost)
			assert.deepEqual(usage, {
				type: "usage",
				inputTokens: 800,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheWriteTokens: 100,
				totalCost: 0,
			})
		})
	}

	it("retains PAYG estimates for a replacement or environment-provided request key", async () => {
		const handler = new UnbiasedHandler({ unbiasedApiKey: "different-effective-key" })
		assert.deepEqual(handler.getModel().info, unbiasedModels.pareto)
		const usage = await requestUsage(handler)
		assert.ok(Math.abs(usage.totalCost! - 0.00555) < 1e-9)
	})

	it("retains a provider-reported cost for API-key requests", async () => {
		const handler = new UnbiasedHandler({ unbiasedApiKey: "manual-key" })
		assert.equal((await requestUsage(handler, 4.2)).totalCost, 4.2)
	})

	it("does not invent subscription pricing for a key without a saved OAuth fingerprint", () => {
		globalState.unbiasedOAuthApiKeyHash = undefined
		assert.deepEqual(new UnbiasedHandler({ unbiasedApiKey: oauthKey }).getModel().info, unbiasedModels.pareto)
	})

	it("keeps fallback cost calculations at zero for subscription input, output, and cache tokens", () => {
		const handler = new UnbiasedHandler({ unbiasedApiKey: oauthKey })
		const info = handler.getModel().info
		assert.equal(info.contextWindow, unbiasedModels.pareto.contextWindow)
		assert.equal(info.maxTokens, unbiasedModels.pareto.maxTokens)
		assert.equal(info.supportsPromptCache, true)
		assert.equal(calculateApiCostAnthropic(info, 800, 500, 100, 200), 0)
		assert.equal(unbiasedModels.pareto.inputPrice, 2.5)
		assert.equal(unbiasedModels.pareto.outputPrice, 7.5)
		assert.equal(unbiasedModels.pareto.cacheReadsPrice, 0.25)
	})

	it("keeps the handler's pricing stable after another account replaces the default", async () => {
		const handler = new UnbiasedHandler({ unbiasedApiKey: oauthKey })
		globalState.unbiasedOAuthApiKeyHash = "another-account-fingerprint"
		assert.equal(handler.getModel().info.inputPrice, 0)
		assert.equal((await requestUsage(handler, 4.2)).totalCost, 0)
	})

	it("applies subscription pricing through Plan, Act, and Utility provider dispatch", () => {
		const configuration = { apiProvider: "unbiased" as const, unbiasedApiKey: oauthKey }
		assert.equal(buildApiHandler(configuration, "plan").getModel().info.inputPrice, 0)
		assert.equal(buildApiHandler(configuration, "act").getModel().info.inputPrice, 0)
		assert.equal(
			buildApiHandlerForSelection(configuration, { provider: "unbiased", modelId: "pareto" }).getModel().info.inputPrice,
			0,
		)
	})

	it("applies subscription accounting to fetched preview metadata without mutating PAYG prices", async () => {
		const previewId = "pareto-26.10-preview"
		const previewInfo = {
			...unbiasedModels.pareto,
			contextWindow: 1_048_576,
			inputPrice: 0.8,
			outputPrice: 3.2,
			cacheReadsPrice: 0.03,
		}
		sandbox.stub(unbiasedCatalog, "getCachedUnbiasedModels").returns({ [previewId]: previewInfo })
		const handler = new UnbiasedHandler({ unbiasedApiKey: oauthKey, apiModelId: previewId })
		assert.equal(handler.getModel().id, previewId)
		assert.equal(handler.getModel().info.contextWindow, 1_048_576)
		assert.equal(handler.getModel().info.inputPrice, 0)
		assert.equal((await requestUsage(handler, 4.2)).totalCost, 0)
		assert.equal(previewInfo.inputPrice, 0.8)
	})

	it("supports model discovery before account storage is initialized", () => {
		;(StateManager.isInitialized as sinon.SinonStub).returns(false)
		assert.deepEqual(new UnbiasedHandler({}).getModel().info, unbiasedModels.pareto)
		assert.equal((StateManager.get as sinon.SinonStub).called, false)
	})
})
describe("Unbiased dynamic model selection", () => {
	const previewId = "pareto-26.10-preview"
	const previewInfo = {
		...unbiasedModels.pareto,
		contextWindow: 1_048_576,
		inputPrice: 0.8,
		outputPrice: 3.2,
		cacheReadsPrice: 0.03,
	}

	beforeEach(() => {
		sinon.stub(StateManager, "isInitialized").returns(false)
		sinon.stub(unbiasedCatalog, "getCachedUnbiasedModels").returns({ [previewId]: previewInfo })
	})
	afterEach(() => sinon.restore())

	it("sends the selected model ID and its fetched output limit", async () => {
		const handler = new UnbiasedHandler({ unbiasedApiKey: "private-key", apiModelId: previewId })
		assert.deepEqual(handler.getModel(), { id: previewId, info: previewInfo })
		const create = sinon.stub().resolves(emptyStream)
		Object.defineProperty(handler, "client", { value: { chat: { completions: { create } } } })
		for await (const _chunk of handler.createMessage("system", [])) {
		}
		assert.equal(create.firstCall.args[0].model, previewId)
		assert.equal(create.firstCall.args[0].max_tokens, 131_072)
	})

	it("retains a saved Pareto version without fresh catalog metadata", () => {
		;(unbiasedCatalog.getCachedUnbiasedModels as sinon.SinonStub).returns(undefined)
		assert.deepEqual(new UnbiasedHandler({ apiModelId: previewId }).getModel(), {
			id: previewId,
			info: { supportsPromptCache: false },
		})
	})

	it("ignores a different provider's leftover generic model ID", () => {
		assert.deepEqual(new UnbiasedHandler({ apiModelId: "claude-sonnet-4-6" }).getModel(), {
			id: "pareto",
			info: unbiasedModels.pareto,
		})
	})

	it("uses the selected IDs through Plan, Act, and Utility dispatch", () => {
		const configuration = {
			apiProvider: "unbiased" as const,
			unbiasedApiKey: "private-key",
			planModeApiModelId: "pareto-26.9",
			actModeApiModelId: previewId,
		}
		assert.equal(buildApiHandler(configuration, "plan").getModel().id, "pareto-26.9")
		assert.equal(buildApiHandler(configuration, "act").getModel().id, previewId)
		assert.equal(
			buildApiHandlerForSelection(configuration, { provider: "unbiased", modelId: previewId }).getModel().id,
			previewId,
		)
	})
})
