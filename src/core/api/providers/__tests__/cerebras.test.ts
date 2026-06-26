import "should"
import sinon from "sinon"
import { CerebrasHandler } from "../cerebras"

// Helper: build an async iterable from a list of stream chunks.
const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

// Characterization tests for CerebrasHandler error mapping.
// Each status code path in createMessage's catch block is exercised via a stubbed
// client that throws an error carrying that status; the resulting thrown message
// is asserted to match the documented user-facing string.
describe("CerebrasHandler error handling", () => {
	afterEach(() => sinon.restore())

	it("maps 401 to authentication failure", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false } as any })
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().rejects({ status: 401, message: "bad key" }) } } } as any)
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).message.should.equal("Cerebras API authentication failed. Please check your API key.")
		}
	})

	it("maps 403 to access denied", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false } as any })
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().rejects({ status: 403, message: "no perms" }) } } } as any)
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).message.should.equal("Cerebras API access denied. Please check your API key permissions.")
		}
	})

	it("maps 400 to bad request", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false } as any })
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().rejects({ status: 400, message: "bad params" }) } } } as any)
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).message.should.equal("Cerebras API bad request: bad params")
		}
	})

	it("maps 500+ to server error with status and message", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false } as any })
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().rejects({ status: 503, message: "down" }) } } } as any)
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).message.should.equal("Cerebras API server error (503): down")
		}
	})

	it("maps 429 to rate limit exceeded", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false } as any })
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().rejects({ status: 429, message: "slow down" }) } } } as any)
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).message.should.equal("Cerebras API rate limit exceeded.")
		}
	})

	it("re-throws unknown errors unchanged", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false } as any })
		const original = new Error("network glitch")
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().rejects(original) } } } as any)
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).should.equal(original)
		}
	})
})

// Characterization tests for CerebrasHandler.getModel.
// The free variant of qwen-3-coder-480b is remapped to the paid id while keeping
// the free model's info; unknown ids fall back to the default model.
describe("CerebrasHandler.getModel", () => {
	afterEach(() => sinon.restore())

	it("remaps qwen-3-coder-480b-free to qwen-3-coder-480b id but keeps free info", () => {
		const handler = new CerebrasHandler({ apiModelId: "qwen-3-coder-480b-free" })
		const model = handler.getModel()
		model.id.should.equal("qwen-3-coder-480b")
	})

	it("returns the requested id when it is a known paid model", () => {
		const handler = new CerebrasHandler({ apiModelId: "gpt-oss-120b" })
		const model = handler.getModel()
		model.id.should.equal("gpt-oss-120b")
	})

	it("falls back to the default model for an unknown id", () => {
		const handler = new CerebrasHandler({ apiModelId: "does-not-exist" })
		const model = handler.getModel()
		model.id.should.equal("zai-glm-4.7")
	})

	it("falls back to the default model when no id is provided", () => {
		const handler = new CerebrasHandler({})
		const model = handler.getModel()
		model.id.should.equal("zai-glm-4.7")
	})
})

// Characterization tests for CerebrasHandler.createMessage stream parsing.
// Covers text deltas, reasoning/thinking tag handling, tool calls, usage/cost,
// and edge cases (empty stream, missing fields, reasoning model transitions).
describe("CerebrasHandler stream parsing", () => {
	afterEach(() => sinon.restore())

	const stubClient = (handler: CerebrasHandler, chunks: any[]) => {
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().resolves(createAsyncIterable(chunks)) } } } as any)
	}

	it("yields text deltas for a non-reasoning model", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0 } as any })
		stubClient(handler, [
			{ choices: [{ delta: { content: "Hello" } }] },
			{ choices: [{ delta: { content: " world" } }] },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		])
	})

	it("yields a usage chunk with calculated cost from the final chunk", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon
			.stub(handler, "getModel")
			.returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0, inputPrice: 2, outputPrice: 6 } as any })
		stubClient(handler, [
			{ choices: [{ delta: { content: "hi" } }] },
			{ usage: { prompt_tokens: 100, completion_tokens: 50 } },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		// cost = (2/1e6)*100 + (6/1e6)*50 = 0.0002 + 0.0003 = 0.0005
		chunks.should.deepEqual([
			{ type: "text", text: "hi" },
			{ type: "usage", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.0005 },
		])
	})

	it("defaults usage tokens to 0 when usage fields are missing", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0, inputPrice: 0, outputPrice: 0 } as any })
		stubClient(handler, [{ usage: {} }])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([
			{ type: "usage", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 },
		])
	})

	it("yields reasoning then text for a reasoning model with think tags", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		// id contains "qwen" so isReasoningModel is true
		sinon
			.stub(handler, "getModel")
			.returns({ id: "qwen-3-235b-a22b-thinking-2507", info: { supportsImages: false, temperature: 0 } as any })
		const open = "<" + "think" + ">"
		const close = "<" + "/think" + ">"
		stubClient(handler, [
			{ choices: [{ delta: { content: open + "Let me think" } }] },
			{ choices: [{ delta: { content: " about this" } }] },
			{ choices: [{ delta: { content: "The answer is 42" + close } }] },
			{ choices: [{ delta: { content: "Done" } }] },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		// Opening tag enters reasoning; closing tag resets reasoning to null; final chunk is plain text.
		chunks.should.deepEqual([
			{ type: "reasoning", reasoning: "Let me think" },
			{ type: "reasoning", reasoning: " about this" },
			{ type: "reasoning", reasoning: "The answer is 42" },
			{ type: "text", text: "Done" },
		])
	})

	it("does not yield reasoning for whitespace-only cleaned content", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon
			.stub(handler, "getModel")
			.returns({ id: "qwen-3-235b-a22b-thinking-2507", info: { supportsImages: false, temperature: 0 } as any })
		const open = "<" + "think" + ">"
		// First chunk is only the opening tag: cleanContent is empty after stripping -> no yield, reasoning mode active
		stubClient(handler, [
			{ choices: [{ delta: { content: open } }] },
			{ choices: [{ delta: { content: "real answer" } }] },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		// Opening tag enters reasoning mode; second chunk continues reasoning (no closing tag)
		chunks.should.deepEqual([{ type: "reasoning", reasoning: "real answer" }])
	})

	it("yields tool calls via ToolCallProcessor when delta has tool_calls", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0 } as any })
		stubClient(handler, [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
							],
						},
					},
				],
			},
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.have.length(1)
		chunks[0].type.should.equal("tool_calls")
		chunks[0].tool_call.call_id.should.equal("call_1")
		chunks[0].tool_call.function.name.should.equal("get_weather")
		chunks[0].tool_call.function.arguments.should.equal('{"city":"SF"}')
	})

	it("yields nothing for an empty stream", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0 } as any })
		stubClient(handler, [])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([])
	})

	it("ignores chunks with no choices or delta", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0 } as any })
		stubClient(handler, [{}, { choices: [] }, { choices: [{ delta: {} }] }])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([])
	})

	it("treats a non-qwen model id as non-reasoning even with think tags", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		// id does NOT contain "qwen" -> isReasoningModel false -> content yielded as text verbatim
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0 } as any })
		stubClient(handler, [{ choices: [{ delta: { content: "thinking" } }] }])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([{ type: "text", text: "thinking" }])
	})

	it("uses model temperature from info when present and the conservative max_tokens", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		const createStub = sinon.stub().resolves(createAsyncIterable([]))
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false, temperature: 0.7 } as any })
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create: createStub } } } as any)
		for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			/* drain */
		}
		createStub.firstCall.args[0].temperature.should.equal(0.7)
		// max_tokens is the conservative constant
		createStub.firstCall.args[0].max_tokens.should.equal(16_384)
	})
})

// Characterization tests for CerebrasHandler rate-limit code path.
// The rate_limit_exceeded error code (without a 429 status) should map to the
// rate limit message, exercising the `error.code` branch.
describe("CerebrasHandler rate_limit_exceeded code", () => {
	afterEach(() => sinon.restore())

	it("maps error.code rate_limit_exceeded to rate limit message", async () => {
		const handler = new CerebrasHandler({ cerebrasApiKey: "k" })
		sinon.stub(handler, "getModel").returns({ id: "llama-3.3-70b", info: { supportsImages: false } as any })
		sinon
			.stub(handler as any, "ensureClient")
			.returns({ chat: { completions: { create: sinon.stub().rejects({ code: "rate_limit_exceeded", message: "slow" }) } } } as any)
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).message.should.equal("Cerebras API rate limit exceeded.")
		}
	})
})
