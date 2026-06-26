import "should"
import { expect } from "chai"
import sinon from "sinon"
import { QwenCodeHandler } from "../qwen-code"

// Helper: build an async iterable from a list of stream chunks.
const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

// Characterization tests for QwenCodeHandler.callApiWithRetry.
// On 401, the handler refreshes the access token and retries the call once.
// Non-401 errors are re-thrown unchanged.
describe("QwenCodeHandler.callApiWithRetry", () => {
	afterEach(() => sinon.restore())

	it("refreshes token and retries on 401", async () => {
		const handler = new QwenCodeHandler({})
		const freshCreds = {
			access_token: "new-token",
			refresh_token: "r",
			token_type: "bearer",
			expiry_date: Date.now() + 60000,
			resource_url: "https://example.com/v1",
		}
		sinon.stub(handler as any, "refreshAccessToken").resolves(freshCreds)
		const fakeClient = { apiKey: "old", baseURL: "old" }
		sinon.stub(handler as any, "ensureClient").returns(fakeClient)

		let calls = 0
		const apiCall = async () => {
			calls++
			if (calls === 1) throw Object.assign(new Error("expired"), { status: 401 })
			return "success"
		}

		const result = await (handler as any).callApiWithRetry(apiCall)
		result.should.equal("success")
		calls.should.equal(2)
		fakeClient.apiKey.should.equal("new-token")
		fakeClient.baseURL.should.equal("https://example.com/v1")
	})

	it("re-throws non-401 errors without retry", async () => {
		const handler = new QwenCodeHandler({})
		sinon.stub(handler as any, "refreshAccessToken").resolves({} as any)

		let calls = 0
		const apiCall = async () => {
			calls++
			throw Object.assign(new Error("server down"), { status: 500 })
		}

		try {
			await (handler as any).callApiWithRetry(apiCall)
			throw new Error("expected throw")
		} catch (e) {
			;(e as Error).message.should.equal("server down")
		}
		calls.should.equal(1)
	})
})

// Characterization tests for QwenCodeHandler.getModel.
// Known ids are returned as-is; unknown/missing ids fall back to the default model.
describe("QwenCodeHandler.getModel", () => {
	afterEach(() => sinon.restore())

	it("returns the requested id when it is a known model", () => {
		const handler = new QwenCodeHandler({ apiModelId: "qwen3-coder-flash" })
		const model = handler.getModel()
		model.id.should.equal("qwen3-coder-flash")
	})

	it("falls back to the default model for an unknown id", () => {
		const handler = new QwenCodeHandler({ apiModelId: "does-not-exist" })
		const model = handler.getModel()
		model.id.should.equal("qwen3-coder-plus")
	})

	it("falls back to the default model when no id is provided", () => {
		const handler = new QwenCodeHandler({})
		const model = handler.getModel()
		model.id.should.equal("qwen3-coder-plus")
	})
})

// Characterization tests for QwenCodeHandler.createMessage stream parsing.
// Covers text deltas (with cumulative-content dedup), thinking block parsing,
// reasoning_content (o1-style), tool calls, usage, and edge cases.
describe("QwenCodeHandler stream parsing", () => {
	afterEach(() => sinon.restore())

	// Stubs auth + client so createMessage can focus on stream parsing.
	const setupHandler = (chunks: any[], modelInfo?: any) => {
		const handler = new QwenCodeHandler({})
		sinon.stub(handler as any, "ensureAuthenticated").resolves()
		const createStub = sinon.stub().resolves(createAsyncIterable(chunks))
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create: createStub } } } as any)
		sinon.stub(handler, "getModel").returns({
			id: "qwen3-coder-plus",
			info: modelInfo ?? { supportsImages: false, maxTokens: 4096 },
		})
		return { handler, createStub }
	}

	it("yields text deltas with cumulative-content dedup", async () => {
		const { handler } = setupHandler([
			{ choices: [{ delta: { content: "Hello" } }] },
			{ choices: [{ delta: { content: "Hello world" } }] },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		// Second chunk's content starts with fullContent ("Hello") so only " world" is yielded
		chunks.should.deepEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		])
	})

	it("yields full text when content does not start with previous fullContent", async () => {
		const { handler } = setupHandler([
			{ choices: [{ delta: { content: "Hello" } }] },
			{ choices: [{ delta: { content: " world" } }] },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		// " world" does not start with "Hello" so it's yielded in full
		chunks.should.deepEqual([
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		])
	})

	it("parses thinking blocks and yields reasoning then text", async () => {
		const open = "<" + "think" + ">"
		const close = "<" + "/think" + ">"
		const { handler } = setupHandler([{ choices: [{ delta: { content: `Let me think${open} about this${close}` } }] }])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		// Split by </?think>: ["Let me think", " about this", ""]
		// index 0 (even) -> text, index 1 (odd) -> reasoning, index 2 (even, empty) -> skipped
		chunks.should.deepEqual([
			{ type: "text", text: "Let me think" },
			{ type: "reasoning", reasoning: " about this" },
		])
	})

	it("yields reasoning_content as reasoning chunks (o1-style)", async () => {
		const { handler } = setupHandler([
			{ choices: [{ delta: { reasoning_content: "thinking hard" } }] },
			{ choices: [{ delta: { reasoning_content: " still thinking" } }] },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([
			{ type: "reasoning", reasoning: "thinking hard" },
			{ type: "reasoning", reasoning: " still thinking" },
		])
	})

	it("yields tool calls via ToolCallProcessor", async () => {
		const { handler } = setupHandler([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "get_weather", arguments: '{"city":"SF"}' },
								},
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
	})

	it("yields a usage chunk from the final chunk", async () => {
		const { handler } = setupHandler([
			{ choices: [{ delta: { content: "hi" } }] },
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([
			{ type: "text", text: "hi" },
			{ type: "usage", inputTokens: 10, outputTokens: 5 },
		])
	})

	it("defaults usage tokens to 0 when usage fields are missing", async () => {
		const { handler } = setupHandler([{ choices: [], usage: {} }])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([{ type: "usage", inputTokens: 0, outputTokens: 0 }])
	})

	it("yields nothing for an empty stream", async () => {
		const { handler } = setupHandler([])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([])
	})

	it("ignores chunks with empty choices array or empty delta", async () => {
		const { handler } = setupHandler([{ choices: [] }, { choices: [{ delta: {} }] }])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([])
	})

	it("throws when a chunk has no choices field at all (edge case)", async () => {
		// The code does `apiChunk.choices[0]?.delta` which throws if choices is undefined
		const { handler } = setupHandler([{ usage: { prompt_tokens: 1 } }])
		try {
			for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			throw new Error("expected throw")
		} catch (e) {
			expect((e as Error).message).to.include("Cannot read properties of undefined")
		}
	})

	it("does not yield empty text when newText is empty after dedup", async () => {
		const { handler } = setupHandler([
			{ choices: [{ delta: { content: "Hello" } }] },
			{ choices: [{ delta: { content: "Hello" } }] },
		])
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		// Second chunk: newText starts with fullContent "Hello" -> newText becomes "" -> no yield
		chunks.should.deepEqual([{ type: "text", text: "Hello" }])
	})

	it("passes model id, temperature 0, and stream_options to the API call", async () => {
		const { handler, createStub } = setupHandler([])
		for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			/* drain */
		}
		const params = createStub.firstCall.args[0]
		params.model.should.equal("qwen3-coder-plus")
		params.temperature.should.equal(0)
		params.stream.should.equal(true)
		params.stream_options.should.deepEqual({ include_usage: true })
		params.max_completion_tokens.should.equal(4096)
	})
})
