/**
 * Tests for MinimaxHandler stream dispatch.
 * Verifies the flattened handler functions correctly translate Anthropic RawMessageStreamEvent
 * variants into Dirac ApiStreamChunk. Focuses on edge cases: missing optional fields,
 * multi-block text, redacted thinking, tool-call state lifecycle, and unknown chunk types.
 */
import { Anthropic } from "@anthropic-ai/sdk"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import { minimaxDefaultModelId, minimaxModels, MinimaxModelId } from "@shared/api"
import { MinimaxHandler } from "../minimax"

// --- Typed stream-event builders: catch SDK fixture drift at compile time ---
// Minimal valid Message for message_start events — only usage is read by minimax code.
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
			model: "minimax-m2",
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
function msgDelta(usage: { input_tokens?: number; output_tokens?: number }): Anthropic.RawMessageDeltaEvent {
	return {
		type: "message_delta",
		delta: { container: null, stop_details: null, stop_reason: null, stop_sequence: null },
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

describe("MinimaxHandler", () => {
	afterEach(() => sinon.restore())

	describe("getModel", () => {
		it("returns default model when apiModelId is undefined", () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			h.getModel().id.should.equal(minimaxDefaultModelId)
		})
		it("returns default model when apiModelId is not in minimaxModels", () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k", apiModelId: "gpt-4" })
			h.getModel().id.should.equal(minimaxDefaultModelId)
		})
		it("returns configured model when apiModelId is valid", () => {
			const validId = Object.keys(minimaxModels)[0] as MinimaxModelId
			const h = new MinimaxHandler({ minimaxApiKey: "k", apiModelId: validId })
			h.getModel().id.should.equal(validId)
		})
	})

	describe("ensureClient", () => {
		it("throws if minimaxApiKey is missing", () => {
			const h = new MinimaxHandler({})
			should.throws(() => (h as any).ensureClient(), /MiniMax API key is required/)
		})
		it("throws if minimaxApiKey is empty string", () => {
			const h = new MinimaxHandler({ minimaxApiKey: "" })
			should.throws(() => (h as any).ensureClient(), /MiniMax API key is required/)
		})
	})

	describe("createMessage stream dispatch", () => {
		function stubStream(handler: MinimaxHandler, chunks: Anthropic.RawMessageStreamEvent[]) {
			const stream = fakeStream(chunks)
			sinon.stub(handler as any, "ensureClient").returns({
				messages: { create: sinon.stub().resolves(stream) },
			})
		}

		it("emits usage chunk on message_start with cache tokens", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
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

		it("emits usage chunk on message_start with zero tokens defaulting to 0", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
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

		it("emits usage chunk on message_delta", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [msgDelta({ input_tokens: 10, output_tokens: 5 })])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "usage", inputTokens: 10, outputTokens: 5 })
		})

		it("emits nothing on message_stop", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [msgStop()])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("emits reasoning chunk on thinking content_block_start", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockStart(0, thinkingBlock("reasoning here", "sig-abc"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "reasoning here", signature: "sig-abc" })
		})

		// Intentionally malformed: ThinkingBlock requires `thinking` field — testing missing-field fallback.
		it("emits reasoning with empty string when thinking field is missing", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			const malformed = blockStart(0, { type: "thinking", signature: "sig" } as unknown as Anthropic.ThinkingBlock)
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "", signature: "sig" })
		})

		it("emits redacted reasoning chunk on redacted_thinking", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockStart(0, redactedThinkingBlock("encrypted-bytes"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({
				type: "reasoning",
				reasoning: "[Redacted thinking block]",
				redacted_data: "encrypted-bytes",
			})
		})

		it("inserts newline before second text block (index > 0)", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockStart(0, textBlock("first")), blockStart(1, textBlock("second"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(3)
			out[0].should.deepEqual({ type: "text", text: "first" })
			out[1].should.deepEqual({ type: "text", text: "\n" })
			out[2].should.deepEqual({ type: "text", text: "second" })
		})

		it("does NOT insert newline before first text block (index 0)", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockStart(0, textBlock("first"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "text", text: "first" })
		})

		it("captures tool_use id and name on content_block_start", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockStart(0, toolUseBlock("tool-1", "search")), blockDelta(0, inputJsonDelta('{"q":"hi"}'))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({
				type: "tool_calls",
				tool_call: {
					id: "tool-1",
					name: "search",
					arguments: "", // outer spread keeps initial empty state
					function: { id: "tool-1", name: "search", arguments: '{"q":"hi"}' },
				},
			})
		})

		it("ignores input_json_delta when no tool_use was started", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockDelta(0, inputJsonDelta('{"q":"hi"}'))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("ignores input_json_delta when partial_json is empty", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockStart(0, toolUseBlock("t1", "n")), blockDelta(0, inputJsonDelta(""))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("resets tool call state on content_block_stop", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockStart(0, toolUseBlock("t1", "n")), blockStop(0), blockDelta(0, inputJsonDelta('{"x":1}'))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("emits reasoning on thinking_delta", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockDelta(0, thinkingDelta("more reasoning"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "more reasoning" })
		})

		it("emits reasoning with signature on signature_delta", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockDelta(0, signatureDelta("sig-xyz"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "reasoning", reasoning: "", signature: "sig-xyz" })
		})

		it("does NOT emit on signature_delta when signature is empty", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockDelta(0, signatureDelta(""))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("emits text on text_delta", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [blockDelta(0, textDelta("hello world"))])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out[0].should.deepEqual({ type: "text", text: "hello world" })
		})

		// Intentionally invalid: testing graceful handling of unknown event types from the SDK.
		it("ignores unknown chunk types gracefully", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [{ type: "unknown_event" } as unknown as Anthropic.RawMessageStreamEvent])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		// Intentionally invalid: testing graceful handling of unknown content block types.
		it("ignores unknown content_block types", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			const malformed = blockStart(0, {
				type: "unknown_block",
			} as unknown as Anthropic.RawContentBlockStartEvent["content_block"])
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		// Intentionally invalid: testing graceful handling of unknown delta types.
		it("ignores unknown delta types", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			const malformed = blockDelta(0, { type: "unknown_delta" } as unknown as Anthropic.RawContentBlockDelta)
			stubStream(h, [malformed])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("emits nothing on empty stream", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		it("handles full multi-event stream in correct order", async () => {
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			stubStream(h, [
				msgStart({ input_tokens: 10, output_tokens: 0 }),
				blockStart(0, textBlock("Hello")),
				blockDelta(0, textDelta(" world")),
				blockStop(0),
				msgDelta({ input_tokens: 10, output_tokens: 2 }),
				msgStop(),
			])
			const out = await collect(h.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(4)
			out[0].type.should.equal("usage")
			out[1].type.should.equal("text")
			out[2].type.should.equal("text")
			out[3].type.should.equal("usage")
		})
	})
})
