import "should"
import { StateManager } from "@core/storage/StateManager"
import { liteLlmDefaultModelId, liteLlmModelInfoSaneDefaults } from "@shared/api"
import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { LiteLlmHandler } from "../litellm"

// Builds an async iterable that yields the provided chunks then closes.
const createAsyncIterable = (data: readonly unknown[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

describe("LiteLlmHandler (characterization)", () => {
	afterEach(() => sinon.restore())

	// Helper that wires up a handler with ensureClient, getModel and the private
	// modelInfo lookup stubbed so createMessage can run without network access.
	const makeHandler = (opts: { createStub: sinon.SinonStub; modelId?: string }) => {
		const handler = new LiteLlmHandler({
			liteLlmApiKey: "test-api-key",
			liteLlmBaseUrl: "http://localhost:4000",
			liteLlmModelId: opts.modelId,
		})
		const fakeClient = { chat: { completions: { create: opts.createStub } }, baseURL: "http://localhost:4000" }
		sinon.stub(handler as any, "ensureClient").returns(fakeClient as any)
		sinon.stub(handler, "getModel").returns({
			id: opts.modelId || liteLlmDefaultModelId,
			info: liteLlmModelInfoSaneDefaults as any,
		})
		// modelInfo drives cache control + cost lookups; return undefined so no fetch happens and costs default to 0.
		sinon.stub(handler as any, "modelInfo").resolves(undefined)
		return handler
	}

	const collect = async (gen: AsyncIterable<any>) => {
		const out: any[] = []
		for await (const chunk of gen) out.push(chunk)
		return out
	}

	describe("getModel", () => {
		it("returns the default model id when none is configured", () => {
			const stateManagerStub = sinon.createStubInstance(StateManager)
			stateManagerStub.getModelInfo.returns(undefined)
			sinon.stub(StateManager, "get").returns(stateManagerStub as any)

			const handler = new LiteLlmHandler({ liteLlmApiKey: "k" })
			const result = handler.getModel()

			result.id.should.equal(liteLlmDefaultModelId)
			result.info.should.deepEqual(liteLlmModelInfoSaneDefaults)
		})

		it("returns the configured model id", () => {
			const stateManagerStub = sinon.createStubInstance(StateManager)
			stateManagerStub.getModelInfo.returns(undefined)
			sinon.stub(StateManager, "get").returns(stateManagerStub as any)

			const handler = new LiteLlmHandler({ liteLlmApiKey: "k", liteLlmModelId: "openai/gpt-5" })
			const result = handler.getModel()

			result.id.should.equal("openai/gpt-5")
		})

		it("prefers cached model info from StateManager over sane defaults", () => {
			const cached = { ...liteLlmModelInfoSaneDefaults, inputPrice: 42 } as any
			const stateManagerStub = sinon.createStubInstance(StateManager)
			stateManagerStub.getModelInfo.returns(cached)
			sinon.stub(StateManager, "get").returns(stateManagerStub as any)

			const handler = new LiteLlmHandler({ liteLlmApiKey: "k" })
			const result = handler.getModel()

			result.info.should.equal(cached)
		})
	})

	describe("createMessage stream parsing", () => {
		it("emits text chunks for each delta with content", async () => {
			const createStub = sinon
				.stub()
				.resolves(
					createAsyncIterable([
						{ choices: [{ delta: { content: "Hello" } }] },
						{ choices: [{ delta: { content: " world" } }] },
					]),
				)
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([
				{ type: "text", text: "Hello" },
				{ type: "text", text: " world" },
			])
		})

		it("emits a usage chunk with cache tokens from cache_creation_input_tokens", async () => {
			const createStub = sinon.stub().resolves(
				createAsyncIterable([
					{
						choices: [{}],
						usage: {
							prompt_tokens: 100,
							completion_tokens: 50,
							cache_creation_input_tokens: 20,
							cache_read_input_tokens: 10,
						},
					},
				]),
			)
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks.should.have.length(1)
			chunks[0].type.should.equal("usage")
			chunks[0].inputTokens.should.equal(100)
			chunks[0].outputTokens.should.equal(50)
			chunks[0].cacheWriteTokens.should.equal(20)
			chunks[0].cacheReadTokens.should.equal(10)
			// modelInfo stubbed to undefined => costs fall back to 0
			chunks[0].totalCost.should.equal(0)
		})

		it("falls back to prompt_cache_miss_tokens / prompt_cache_hit_tokens when cache fields absent", async () => {
			const createStub = sinon.stub().resolves(
				createAsyncIterable([
					{
						choices: [{}],
						usage: {
							prompt_tokens: 5,
							completion_tokens: 1,
							prompt_cache_miss_tokens: 3,
							prompt_cache_hit_tokens: 2,
						},
					},
				]),
			)
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks[0].cacheWriteTokens.should.equal(3)
			chunks[0].cacheReadTokens.should.equal(2)
		})

		it("emits undefined cache tokens when usage has no cache fields", async () => {
			const createStub = sinon
				.stub()
				.resolves(createAsyncIterable([{ choices: [{}], usage: { prompt_tokens: 5, completion_tokens: 1 } }]))
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			expect(chunks[0].cacheWriteTokens).to.be.undefined
			expect(chunks[0].cacheReadTokens).to.be.undefined
		})

		it("emits reasoning chunks when delta carries non-empty reasoning_content", async () => {
			const createStub = sinon
				.stub()
				.resolves(createAsyncIterable([{ choices: [{ delta: { reasoning_content: "thinking..." } }] }]))
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "reasoning", reasoning: "thinking..." }])
		})

		// Characterizes a source bug: tool_calls are only processed when delta.content is truthy.
		it("emits tool_calls chunks only when delta also carries content", async () => {
			const createStub = sinon.stub().resolves(
				createAsyncIterable([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											function: { name: "read_file", arguments: '{"path":"a"}' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									content: "x",
									tool_calls: [{ index: 0, id: "call_2", function: { name: "write_file", arguments: "{}" } }],
								},
							},
						],
					},
				]),
			)
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			// First chunk (tool_calls without content) is silently dropped.
			chunks.should.have.length(2)
			chunks[0].type.should.equal("tool_calls")
			chunks[0].tool_call.call_id.should.equal("call_2")
			chunks[0].tool_call.function.name.should.equal("write_file")
			chunks[1].type.should.equal("text")
			chunks[1].text.should.equal("x")
		})

		it("passes drop_params and stream_options to the client", async () => {
			const createStub = sinon.stub().resolves(createAsyncIterable([]))
			const handler = makeHandler({ createStub })

			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			sinon.assert.calledOnce(createStub)
			const params = createStub.getCall(0).args[0] as any
			params.stream.should.equal(true)
			params.drop_params.should.equal(true)
			params.stream_options.should.deepEqual({ include_usage: true })
		})

		it("omits stream_options for codex models", async () => {
			const createStub = sinon.stub().resolves(createAsyncIterable([]))
			const handler = makeHandler({ createStub, modelId: "openai/codex-mini-latest" })

			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			const params = createStub.getCall(0).args[0] as any
			expect(params.stream_options).to.be.undefined
		})

		it("adds thinking config when thinkingBudgetTokens is set", async () => {
			const createStub = sinon.stub().resolves(createAsyncIterable([]))
			const handler = new LiteLlmHandler({ liteLlmApiKey: "k", liteLlmModelId: "openai/gpt-5", thinkingBudgetTokens: 1024 })
			const fakeClient = { chat: { completions: { create: createStub } }, baseURL: "http://localhost:4000" }
			sinon.stub(handler as any, "ensureClient").returns(fakeClient as any)
			sinon.stub(handler, "getModel").returns({ id: "openai/gpt-5", info: liteLlmModelInfoSaneDefaults as any })
			sinon.stub(handler as any, "modelInfo").resolves(undefined)

			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			const params = createStub.getCall(0).args[0] as any
			params.thinking.should.deepEqual({ type: "enabled", budget_tokens: 1024 })
		})
	})

	describe("createMessage edge cases", () => {
		it("yields nothing for an empty stream", async () => {
			const createStub = sinon.stub().resolves(createAsyncIterable([]))
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("ignores chunks with no choices array", async () => {
			const createStub = sinon.stub().resolves(createAsyncIterable([{}, { choices: undefined }, { choices: [] }]))
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("ignores deltas with empty content string", async () => {
			const createStub = sinon.stub().resolves(createAsyncIterable([{ choices: [{ delta: { content: "" } }] }]))
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("defaults missing prompt/completion tokens to 0 in usage", async () => {
			const createStub = sinon.stub().resolves(createAsyncIterable([{ choices: [{}], usage: {} }]))
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			chunks[0].type.should.equal("usage")
			chunks[0].inputTokens.should.equal(0)
			chunks[0].outputTokens.should.equal(0)
		})

		it("treats usage with zero cache tokens as undefined", async () => {
			const createStub = sinon.stub().resolves(
				createAsyncIterable([
					{
						choices: [{}],
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				]),
			)
			const handler = makeHandler({ createStub })

			const chunks = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))

			expect(chunks[0].cacheWriteTokens).to.be.undefined
			expect(chunks[0].cacheReadTokens).to.be.undefined
		})
	})

	describe("error handling", () => {
		it("throws when liteLlmApiKey is missing and ensureClient is not stubbed", async () => {
			const handler = new LiteLlmHandler({ liteLlmApiKey: undefined })
			sinon.stub(handler, "getModel").returns({ id: liteLlmDefaultModelId, info: liteLlmModelInfoSaneDefaults as any })

			// ensureClient runs inside the generator body, so the error surfaces on iteration.
			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				"LiteLLM API key is required",
			)
		})

		it("propagates errors thrown mid-stream", async () => {
			const createStub = sinon.stub().resolves({
				[Symbol.asyncIterator]: async function* () {
					yield { choices: [{ delta: { content: "partial" } }] }
					throw new Error("upstream connection reset")
				},
			})
			const handler = makeHandler({ createStub })

			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				"upstream connection reset",
			)
		})

		it("propagates errors from client.chat.completions.create", async () => {
			const createStub = sinon.stub().rejects(new Error("rate limited"))
			const handler = makeHandler({ createStub })

			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }])).should.be.rejectedWith("rate limited")
		})

		it("calculateCost falls back to 0 when modelInfo lookup throws", async () => {
			const handler = new LiteLlmHandler({ liteLlmApiKey: "k", liteLlmModelId: "openai/gpt-5" })
			sinon.stub(handler as any, "modelInfo").rejects(new Error("boom"))

			// getModelCostInfo swallows the error and returns zero costs.
			const cost = await handler.calculateCost(100, 50)

			cost!.should.equal(0)
		})

		it("calculateCost computes total from model cost info including cache tokens", async () => {
			const handler = new LiteLlmHandler({ liteLlmApiKey: "k", liteLlmModelId: "openai/gpt-5" })
			sinon.stub(handler as any, "modelInfo").resolves({
				model_name: "openai/gpt-5",
				litellm_params: { model: "openai/gpt-5" },
				model_info: {
					input_cost_per_token: 0.01,
					output_cost_per_token: 0.02,
					cache_creation_input_token_cost: 0.03,
					cache_read_input_token_cost: 0.001,
				},
			} as any)

			// prompt=100, completion=50, cache_creation=20, cache_read=10
			// input = max(0, 100-10)*0.01 = 0.9
			// output = 50*0.02 = 1.0
			// cacheCreation = 20*0.03 = 0.6
			// cacheRead = 10*0.001 = 0.01
			// total = 2.51
			const cost = await handler.calculateCost(100, 50, 20, 10)

			cost!.should.equal(2.51)
		})
	})
})
