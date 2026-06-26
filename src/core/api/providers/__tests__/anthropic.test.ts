import { Anthropic } from "@anthropic-ai/sdk"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import { ANTHROPIC_BETAS, anthropicModels } from "@shared/api"
import { expect } from "chai"
import { ANTHROPIC_FAST_MODE_BETA, AnthropicHandler } from "../anthropic"

// --- Typed stream-event builders: catch SDK fixture drift at compile time ---
function msgStart(usage: {
	input_tokens?: number
	output_tokens?: number
	cache_creation_input_tokens?: number | null
	cache_read_input_tokens?: number | null
}): Anthropic.RawMessageStartEvent {
	return {
		type: "message_start",
		message: {
			id: "msg_test",
			container: null,
			content: [],
			model: "claude-sonnet-4-6",
			role: "assistant",
			stop_details: null,
			stop_reason: null,
			stop_sequence: null,
			type: "message",
			usage: {
				cache_creation: null,
				cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
				cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
				inference_geo: null,
				input_tokens: usage.input_tokens ?? 0,
				output_tokens: usage.output_tokens ?? 0,
				server_tool_use: null,
				service_tier: null,
			},
		},
	}
}
function msgDelta(
	usage: { input_tokens?: number; output_tokens?: number },
	stopReason: Anthropic.Messages.RawMessageDeltaEvent["delta"]["stop_reason"] = null,
): Anthropic.RawMessageDeltaEvent {
	return {
		type: "message_delta",
		delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
		usage: {
			cache_creation_input_tokens: null,
			cache_read_input_tokens: null,
			input_tokens: usage.input_tokens ?? 0,
			output_tokens: usage.output_tokens ?? 0,
			server_tool_use: null,
		},
	}
}
const msgStop = (): Anthropic.RawMessageStopEvent => ({ type: "message_stop" })
function blockStart(
	index: number,
	block: Anthropic.RawContentBlockStartEvent["content_block"],
): Anthropic.RawContentBlockStartEvent {
	return { type: "content_block_start", index, content_block: block }
}
function blockDelta(index: number, delta: Anthropic.RawContentBlockDelta): Anthropic.RawContentBlockDeltaEvent {
	return { type: "content_block_delta", index, delta }
}
const blockStop = (index: number): Anthropic.RawContentBlockStopEvent => ({ type: "content_block_stop", index })

// --- Content-block builders ---
const textBlock = (text: string): Anthropic.TextBlock => ({ type: "text", text, citations: null })
const thinkingBlock = (thinking: string, signature: string): Anthropic.ThinkingBlock => ({
	type: "thinking",
	thinking,
	signature,
})
const redactedThinkingBlock = (data: string): Anthropic.RedactedThinkingBlock => ({ type: "redacted_thinking", data })
const toolUseBlock = (id: string, name: string): Anthropic.ToolUseBlock => ({
	type: "tool_use",
	id,
	name,
	caller: { type: "direct" },
	input: {},
})

// --- Delta builders ---
const textDelta = (text: string): Anthropic.TextDelta => ({ type: "text_delta", text })
const thinkingDelta = (thinking: string): Anthropic.ThinkingDelta => ({ type: "thinking_delta", thinking })
const signatureDelta = (signature: string): Anthropic.SignatureDelta => ({ type: "signature_delta", signature })
const inputJsonDelta = (partial_json: string): Anthropic.InputJSONDelta => ({ type: "input_json_delta", partial_json })

// --- Helpers ---
function fakeStream(chunks: Anthropic.RawMessageStreamEvent[]): AsyncIterable<Anthropic.RawMessageStreamEvent> {
	return {
		[Symbol.asyncIterator]: async function* () {
			yield* chunks
		},
	}
}
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const c of gen) out.push(c)
	return out
}

describe("AnthropicHandler", () => {
	afterEach(() => {
		sinon.restore()
	})

	const createAsyncIterable = (data: readonly unknown[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	describe("getModel", () => {
		it("should return the fast mode model when configured", () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:fast",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-opus-4-6:fast")
			result.info.should.deepEqual(anthropicModels["claude-opus-4-6:fast"])
		})

		it("should return the 1m fast mode model when configured", () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:1m:fast",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-opus-4-6:1m:fast")
			result.info.should.deepEqual(anthropicModels["claude-opus-4-6:1m:fast"])
		})
	})

	describe("createMessage", () => {
		it("should route fast mode requests through the beta messages API", async () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:fast",
			})

			const standardCreate = sinon.stub().resolves(createAsyncIterable())
			const betaCreate = sinon.stub().callsFake(function (this: { _client?: object }, _params: unknown) {
				should.exist(this._client)
				return Promise.resolve(createAsyncIterable())
			})

			sinon.stub(handler as unknown as { ensureClient: () => unknown }, "ensureClient").returns({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: betaCreate,
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			sinon.assert.notCalled(standardCreate)
			sinon.assert.calledOnce(betaCreate)
			sinon.assert.calledWithMatch(betaCreate, {
				model: "claude-opus-4-6",
				betas: [ANTHROPIC_FAST_MODE_BETA],
				speed: "fast",
				stream: true,
			})
		})

		it("should include the 1m beta when routing 1m fast mode requests through the beta messages API", async () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:1m:fast",
			})

			const standardCreate = sinon.stub().resolves(createAsyncIterable())
			const betaCreate = sinon.stub().callsFake(function (this: { _client?: object }, _params: unknown) {
				should.exist(this._client)
				return Promise.resolve(createAsyncIterable())
			})

			sinon.stub(handler as unknown as { ensureClient: () => unknown }, "ensureClient").returns({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: betaCreate,
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			sinon.assert.notCalled(standardCreate)
			sinon.assert.calledOnce(betaCreate)
			sinon.assert.calledWithMatch(betaCreate, {
				model: "claude-opus-4-6",
				betas: [ANTHROPIC_FAST_MODE_BETA, ANTHROPIC_BETAS.CONTEXT_1M],
				speed: "fast",
				stream: true,
			})
		})
	})

	describe("createMessage stream dispatch", () => {
		// Stubs ensureClient + getModel so createMessage uses a cache-supporting model and a fake stream.
		function stubStream(handler: AnthropicHandler, chunks: Anthropic.RawMessageStreamEvent[]) {
			const stream = fakeStream(chunks)
			sinon.stub(handler as any, "ensureClient").returns({
				messages: { create: sinon.stub().resolves(stream) },
			})
			sinon.stub(handler, "getModel").returns({ id: "claude-sonnet-4-6", info: anthropicModels["claude-sonnet-4-6"] })
		}

		it("emits usage chunk on message_start with cache tokens", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [
				msgStart({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 30, cache_read_input_tokens: 20 }),
			])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({
				type: "usage",
				inputTokens: 100,
				outputTokens: 50,
				cacheWriteTokens: 30,
				cacheReadTokens: 20,
			})
		})

		it("defaults missing usage tokens to 0 and cache tokens to undefined", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [msgStart({ input_tokens: 0, output_tokens: 0 })])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({
				type: "usage",
				inputTokens: 0,
				outputTokens: 0,
				cacheWriteTokens: undefined,
				cacheReadTokens: undefined,
			})
		})

		it("emits usage chunk on message_delta with stop_reason", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [msgDelta({ output_tokens: 5 }, "end_turn")])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "usage", inputTokens: 0, outputTokens: 5, stopReason: "end_turn" })
		})

		it("emits usage chunk on message_delta with undefined stop_reason when null", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [msgDelta({ output_tokens: 5 }, null)])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "usage", inputTokens: 0, outputTokens: 5, stopReason: undefined })
		})

		it("defaults message_delta output_tokens to 0 when missing", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [msgDelta({}, null)])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "usage", inputTokens: 0, outputTokens: 0, stopReason: undefined })
		})

		it("emits nothing on message_stop", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [msgStop()])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("emits reasoning chunk on thinking content_block_start", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockStart(0, thinkingBlock("reasoning here", "sig-abc"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "reasoning here", signature: "sig-abc" })
		})

		// Intentionally malformed: ThinkingBlock requires `thinking` field — testing missing-field fallback to empty string.
		it("emits reasoning with empty string when thinking field is missing", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			const malformed = blockStart(0, { type: "thinking", signature: "sig" } as unknown as Anthropic.ThinkingBlock)
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "", signature: "sig" })
		})

		it("emits redacted reasoning chunk on redacted_thinking", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockStart(0, redactedThinkingBlock("encrypted-bytes"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({
				type: "reasoning",
				reasoning: "[Redacted thinking block]",
				redacted_data: "encrypted-bytes",
			})
		})

		it("captures tool_use id and name on content_block_start", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockStart(0, toolUseBlock("tool-1", "search")), blockDelta(0, inputJsonDelta('{"q":"hi"}'))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({
				type: "tool_calls",
				tool_call: { call_id: "tool-1", function: { id: "tool-1", name: "search", arguments: "" } },
			})
		})

		it("ignores tool_use content_block_start when id is missing", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			const malformed = blockStart(0, { type: "tool_use", name: "search", input: {} } as unknown as Anthropic.ToolUseBlock)
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("ignores tool_use content_block_start when name is missing", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			const malformed = blockStart(0, { type: "tool_use", id: "tool-1", input: {} } as unknown as Anthropic.ToolUseBlock)
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("inserts newline before second text block (index > 0)", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockStart(0, textBlock("first")), blockStart(1, textBlock("second"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(3)
			out[0].should.deepEqual({ type: "text", text: "first" })
			out[1].should.deepEqual({ type: "text", text: "\n" })
			out[2].should.deepEqual({ type: "text", text: "second" })
		})

		it("does NOT insert newline before first text block (index 0)", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockStart(0, textBlock("first"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "text", text: "first" })
		})

		it("emits reasoning on thinking_delta", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockDelta(0, thinkingDelta("more reasoning"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "more reasoning" })
		})

		it("emits reasoning with signature on signature_delta", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockDelta(0, signatureDelta("sig-xyz"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "", signature: "sig-xyz" })
		})

		it("does NOT emit on signature_delta when signature is empty", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockDelta(0, signatureDelta(""))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("emits text on text_delta", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockDelta(0, textDelta("hello world"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "text", text: "hello world" })
		})

		it("emits tool_calls with partial_json on input_json_delta after tool_use start", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockStart(0, toolUseBlock("t1", "n")), blockDelta(0, inputJsonDelta('{"x":1}'))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[1].should.deepEqual({
				type: "tool_calls",
				tool_call: { id: "t1", name: "n", arguments: "", function: { id: "t1", name: "n", arguments: '{"x":1}' } },
			})
		})

		it("ignores input_json_delta when no tool_use was started", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockDelta(0, inputJsonDelta('{"q":"hi"}'))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("ignores input_json_delta when partial_json is undefined", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			const malformed = blockDelta(0, { type: "input_json_delta" } as unknown as Anthropic.InputJSONDelta)
			stubStream(h, [blockStart(0, toolUseBlock("t1", "n")), malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(1) // only the tool_use start chunk
		})

		it("resets tool call state on content_block_stop", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [blockStart(0, toolUseBlock("t1", "n")), blockStop(0), blockDelta(0, inputJsonDelta('{"x":1}'))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(1) // only the tool_use start; delta ignored after reset
		})

		// Intentionally invalid: testing graceful handling of unknown event types from the SDK.
		it("ignores unknown chunk types gracefully", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [{ type: "unknown_event" } as unknown as Anthropic.RawMessageStreamEvent])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		// Intentionally invalid: testing graceful handling of unknown content block types.
		it("ignores unknown content_block types", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			const malformed = blockStart(0, {
				type: "unknown_block",
			} as unknown as Anthropic.RawContentBlockStartEvent["content_block"])
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		// Intentionally invalid: testing graceful handling of unknown delta types.
		it("ignores unknown delta types", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			const malformed = blockDelta(0, { type: "unknown_delta" } as unknown as Anthropic.RawContentBlockDelta)
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("emits nothing on empty stream", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("handles full multi-event stream in correct order", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [
				msgStart({ input_tokens: 10, output_tokens: 0 }),
				blockStart(0, textBlock("Hello")),
				blockDelta(0, textDelta(" world")),
				blockStop(0),
				msgDelta({ output_tokens: 2 }, "end_turn"),
				msgStop(),
			])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(4)
			out[0].type.should.equal("usage")
			out[1].type.should.equal("text")
			out[2].type.should.equal("text")
			out[3].type.should.equal("usage")
		})

		it("handles chunk with nullish type via optional chaining", async () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			stubStream(h, [{ type: undefined } as unknown as Anthropic.RawMessageStreamEvent])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})
	})

	describe("ensureClient", () => {
		it("throws if apiKey is missing", () => {
			const h = new AnthropicHandler({})
			should.throws(() => (h as any).ensureClient(), /Anthropic API key is required/)
		})

		it("throws if apiKey is empty string", () => {
			const h = new AnthropicHandler({ apiKey: "" })
			should.throws(() => (h as any).ensureClient(), /Anthropic API key is required/)
		})
	})

	describe("getModel", () => {
		it("returns default model when apiModelId is undefined", () => {
			const h = new AnthropicHandler({ apiKey: "k" })
			const result = h.getModel()
			expect(result.id).to.equal("claude-sonnet-4-6")
		})

		it("returns default model when apiModelId is not in anthropicModels", () => {
			const h = new AnthropicHandler({ apiKey: "k", apiModelId: "gpt-4" })
			const result = h.getModel()
			expect(result.id).to.equal("claude-sonnet-4-6")
		})
	})
})
