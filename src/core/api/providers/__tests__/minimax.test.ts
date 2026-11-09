/**
 * Tests for the MiniMax catalog, request compatibility, and stream dispatch.
 * Verifies the flattened handler functions correctly translate Anthropic RawMessageStreamEvent
 * variants into Dirac ApiStreamChunk. Focuses on edge cases: missing optional fields,
 * multi-block text, redacted thinking, tool-call state lifecycle, and unknown chunk types.
 */
import { Anthropic } from "@anthropic-ai/sdk"
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import { MinimaxModelId, minimaxDefaultModelId, minimaxModels } from "@shared/api"
import type { DiracStorageMessage } from "@/shared/messages/content"
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

async function captureRequest(
	handler: MinimaxHandler,
	messages: DiracStorageMessage[] = [{ role: "user", content: "hello" }],
	tools?: Anthropic.Tool[],
): Promise<MessageCreateParamsStreaming> {
	const create = sinon.stub().resolves(fakeStream([]))
	sinon.stub(handler as any, "ensureClient").returns({ messages: { create } })
	await collect(handler.createMessage("system", messages, tools))
	return create.firstCall.args[0] as MessageCreateParamsStreaming
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

	describe("MiniMax-M3.1-Flash catalog", () => {
		it("adds Flash without changing the default or removing earlier models", () => {
			minimaxDefaultModelId.should.equal("MiniMax-M3")
			Object.keys(minimaxModels).should.containDeep([
				"MiniMax-M2.7",
				"MiniMax-M2.7-highspeed",
				"MiniMax-M3",
				"MiniMax-M3.1-Flash",
			])
			const handler = new MinimaxHandler({ apiModelId: "MiniMax-M3.1-Flash" })
			handler.getModel().id.should.equal("MiniMax-M3.1-Flash")
		})

		it("advertises verified context, output limit, modalities, thinking, tools, and flat pricing", () => {
			minimaxModels["MiniMax-M3.1-Flash"].should.containDeep({
				contextWindow: 1_000_000,
				maxTokens: 524_288,
				supportsImages: true,
				supportsTools: true,
				supportsReasoning: true,
				supportsAdaptiveThinking: true,
				thinkingAlwaysOn: true,
				supportsForcedToolUse: false,
				supportsReasoningEffort: true,
				reasoningEffortOptions: ["low", "medium", "high", "xhigh", "max"],
				defaultReasoningEffort: "max",
				supportsPromptCache: true,
				inputPrice: 0.15,
				outputPrice: 0.6,
				cacheWritesPrice: 0.15,
				cacheReadsPrice: 0.015,
			})
			minimaxModels["MiniMax-M3.1-Flash"].should.not.have.property("tiers")
		})
	})

	describe("createMessage request compatibility", () => {
		const tools: Anthropic.Tool[] = [
			{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: {} } },
		]

		for (const thinkingBudgetTokens of [undefined, 0, 4096]) {
			it(`always enables adaptive Flash thinking with max effort for budget ${thinkingBudgetTokens}`, async () => {
				const request = await captureRequest(
					new MinimaxHandler({ minimaxApiKey: "k", apiModelId: "MiniMax-M3.1-Flash", thinkingBudgetTokens }),
					undefined,
					tools,
				)
				request.model.should.equal("MiniMax-M3.1-Flash")
				request.max_tokens.should.equal(524_288)
				request.thinking!.should.deepEqual({ type: "adaptive" })
				request.output_config!.should.deepEqual({ effort: "max" })
				request.tool_choice!.should.deepEqual({ type: "auto" })
				request.tools!.should.deepEqual(tools)
				should(request.temperature).be.undefined()
			})
		}

		for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"]) {
			it(`sends supported Flash effort ${reasoningEffort}`, async () => {
				const request = await captureRequest(
					new MinimaxHandler({ minimaxApiKey: "k", apiModelId: "MiniMax-M3.1-Flash", reasoningEffort }),
				)
				request.output_config!.should.deepEqual({ effort: reasoningEffort })
				should(request.tool_choice).be.undefined()
				should(request.tools).be.undefined()
			})
		}

		for (const reasoningEffort of ["none", "minimal", "unsupported"]) {
			it(`normalizes stale unsupported Flash effort ${reasoningEffort} to max without disabling thinking`, async () => {
				const request = await captureRequest(
					new MinimaxHandler({ minimaxApiKey: "k", apiModelId: "MiniMax-M3.1-Flash", reasoningEffort }),
				)
				request.output_config!.should.deepEqual({ effort: "max" })
				request.thinking!.should.deepEqual({ type: "adaptive" })
			})
		}

		it("uses capabilities rather than model-name branches for thinking, effort, and tool choice", async () => {
			const handler = new MinimaxHandler({ minimaxApiKey: "k", thinkingBudgetTokens: 0, reasoningEffort: "xhigh" })
			sinon.stub(handler, "getModel").returns({ id: "MiniMax-M2.7", info: minimaxModels["MiniMax-M3.1-Flash"] })
			const request = await captureRequest(handler, undefined, tools)
			request.thinking!.should.deepEqual({ type: "adaptive" })
			request.output_config!.should.deepEqual({ effort: "xhigh" })
			request.tool_choice!.should.deepEqual({ type: "auto" })
		})

		it("preserves signed thinking, text, and tool blocks unchanged across tool-result turns", async () => {
			const messages: DiracStorageMessage[] = [
				{ role: "user", content: "Read a file" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I should read the file.", signature: "original-signature" },
						{ type: "text", text: "Reading the file." },
						{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents" }] },
			]
			const request = await captureRequest(
				new MinimaxHandler({ minimaxApiKey: "k", apiModelId: "MiniMax-M3.1-Flash" }),
				messages,
				tools,
			)
			request.messages.should.deepEqual(messages)
		})

		it("preserves M3's default-off thinking and omits Flash-only effort", async () => {
			const request = await captureRequest(
				new MinimaxHandler({ minimaxApiKey: "k", apiModelId: "MiniMax-M3", reasoningEffort: "max" }),
				undefined,
				tools,
			)
			should(request.thinking).be.undefined()
			should(request.output_config).be.undefined()
			request.temperature!.should.equal(1)
			request.tool_choice!.should.deepEqual({ type: "auto" })
		})

		it("enables M3 thinking with adaptive rather than the legacy budget format when opted in", async () => {
			const request = await captureRequest(
				new MinimaxHandler({ minimaxApiKey: "k", apiModelId: "MiniMax-M3", thinkingBudgetTokens: 4096 }),
				undefined,
				tools,
			)
			request.thinking!.should.deepEqual({ type: "adaptive" })
			should(request.output_config).be.undefined()
			request.tool_choice!.should.deepEqual({ type: "auto" })
		})

		for (const apiModelId of ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]) {
			it(`preserves default request behavior for ${apiModelId}`, async () => {
				const request = await captureRequest(
					new MinimaxHandler({ minimaxApiKey: "k", apiModelId, reasoningEffort: "max" }),
					undefined,
					tools,
				)
				should(request.thinking).be.undefined()
				should(request.output_config).be.undefined()
				request.temperature!.should.equal(1)
				request.tool_choice!.should.deepEqual({ type: "any" })
			})

			it(`preserves fixed-budget thinking for ${apiModelId}`, async () => {
				const request = await captureRequest(
					new MinimaxHandler({ minimaxApiKey: "k", apiModelId, thinkingBudgetTokens: 4096 }),
					undefined,
					tools,
				)
				request.thinking!.should.deepEqual({ type: "enabled", budget_tokens: 4096 })
				should(request.output_config).be.undefined()
				should(request.temperature).be.undefined()
				should(request.tool_choice).be.undefined()
			})
		}
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

		it("removes internal message and block metadata before sending", async () => {
			const create = sinon.stub().resolves(fakeStream([]))
			const h = new MinimaxHandler({ minimaxApiKey: "k" })
			sinon.stub(h as any, "ensureClient").returns({ messages: { create } })
			const messages = [
				{
					role: "assistant",
					id: "internal-response-id",
					ts: 123,
					modelInfo: { providerId: "minimax", modelId: "model", mode: "act" },
					metrics: { cost: 1 },
					content: [
						{
							type: "tool_use",
							id: "tool-1",
							name: "read_file",
							input: { path: "a" },
							call_id: "internal-call-id",
							isComplete: true,
						},
					],
				},
			] as any

			await collect(h.createMessage("sys", messages))

			create.firstCall.args[0].messages.should.deepEqual([
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a" } }],
				},
			])
		})

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
