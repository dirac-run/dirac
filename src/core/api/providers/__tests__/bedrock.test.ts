/**
 * Characterization tests for AwsBedrockHandler.executeConverseStream.
 * Verifies the private async generator correctly translates AWS Bedrock
 * ConverseStream response events into Dirac ApiStreamChunk objects.
 * Covers reasoning, usage, tool calls, text, redacted thinking, signature
 * deltas, error chunks, and cleanup behavior.
 */
import "should"
import type { ModelInfo } from "@shared/api"
import sinon from "sinon"
import { AwsBedrockHandler } from "../bedrock"

// --- Helpers ---
const ZERO_PRICE_MODEL: ModelInfo = { inputPrice: 0, outputPrice: 0, cacheWritesPrice: 0, cacheReadsPrice: 0 } as any

function fakeStream(chunks: any[]): AsyncIterable<any> {
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

// Builds a handler with getBedrockClient stubbed to resolve to a fake client
// whose send() returns { stream: fakeStream(chunks) }.
function makeHandler(chunks: any[]): AwsBedrockHandler {
	const handler = new AwsBedrockHandler({ apiModelId: "anthropic.claude-sonnet-4-6" })
	const fakeClient = { send: sinon.stub().resolves({ stream: fakeStream(chunks) }) }
	sinon.stub(handler as any, "getBedrockClient").resolves(fakeClient as any)
	sinon.stub(handler, "getModel").returns({
		id: "anthropic.claude-sonnet-4-6",
		info: ZERO_PRICE_MODEL,
	})
	return handler
}

// Invoke the private executeConverseStream generator directly.
function runStream(handler: AwsBedrockHandler, chunks: any[]): Promise<any[]> {
	return collect((handler as any).executeConverseStream({}, ZERO_PRICE_MODEL))
}

describe("AwsBedrockHandler.executeConverseStream", () => {
	afterEach(() => sinon.restore())

	describe("metadata thinkingResponse", () => {
		it("yields reasoning for text-type reasoning blocks with signature", async () => {
			const chunks = [
				{
					metadata: {
						additionalModelResponseFields: {
							thinkingResponse: {
								reasoning: [{ type: "text", text: "thinking here", signature: "sig-1" }],
							},
						},
					},
				},
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "thinking here", signature: "sig-1" }])
		})

		it("omits signature when not provided", async () => {
			const chunks = [
				{
					metadata: {
						additionalModelResponseFields: {
							thinkingResponse: {
								reasoning: [{ type: "text", text: "no sig" }],
							},
						},
					},
				},
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "no sig" }])
		})

		it("skips reasoning blocks without text", async () => {
			const chunks = [
				{
					metadata: {
						additionalModelResponseFields: {
							thinkingResponse: {
								reasoning: [{ type: "text" }],
							},
						},
					},
				},
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})

		it("skips non-text reasoning block types", async () => {
			const chunks = [
				{
					metadata: {
						additionalModelResponseFields: {
							thinkingResponse: {
								reasoning: [{ type: "other", text: "ignored" }],
							},
						},
					},
				},
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})
	})

	describe("metadata usage", () => {
		it("yields usage with all token fields and zero cost", async () => {
			const chunks = [
				{
					metadata: { usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheWriteInputTokens: 2 } },
				},
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([
				{
					type: "usage",
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 3,
					cacheWriteTokens: 2,
					totalCost: 0,
				},
			])
		})

		it("defaults missing token fields to 0", async () => {
			const chunks = [{ metadata: { usage: {} } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([
				{
					type: "usage",
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalCost: 0,
				},
			])
		})
	})

	describe("tool use", () => {
		it("yields tool_calls for toolUse start followed by input delta", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu-1", name: "get_weather" } } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":"SF"}' } } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([
				{
					type: "tool_calls",
					tool_call: { call_id: "tu-1", function: { id: "tu-1", name: "get_weather", arguments: '{"city":"SF"}' } },
				},
			])
		})

		it("does not yield tool_call when no matching active tool call exists", async () => {
			const chunks = [{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "x" } } } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})

		it("does not yield tool_call when input is not a string", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu-2", name: "foo" } } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 123 as any } } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})
	})

	describe("thinking blocks", () => {
		it("yields reasoning with signature on thinking contentBlockStart", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking", thinking: "init", signature: "s" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "init", signature: "s" }])
		})

		it("yields nothing on thinking start with no content or signature", async () => {
			const chunks = [{ contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking" } } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})

		it("yields reasoning on thinking_delta", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking" } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { type: "thinking_delta", thinking: "more thought" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "more thought" }])
		})

		it("yields reasoning on delta.thinking without explicit type", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking" } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { thinking: "raw thinking" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "raw thinking" }])
		})

		it("yields reasoning (not text) for text delta when blockType is reasoning", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking" } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "looks like text" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "looks like text" }])
		})
	})

	describe("redacted thinking", () => {
		it("yields redacted reasoning with data", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { type: "redacted_thinking" }, data: "encrypted" } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "[Redacted thinking block]", redacted_data: "encrypted" }])
		})

		it("yields redacted reasoning without data when absent", async () => {
			const chunks = [{ contentBlockStart: { contentBlockIndex: 0, start: { type: "redacted_thinking" } } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "[Redacted thinking block]" }])
		})
	})

	describe("signature delta", () => {
		it("yields reasoning with empty text and signature", async () => {
			const chunks = [
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { type: "signature_delta", signature: "sig-x" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "", signature: "sig-x" }])
		})

		it("does not yield signature_delta without signature", async () => {
			const chunks = [{ contentBlockDelta: { contentBlockIndex: 0, delta: { type: "signature_delta" } } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})
	})

	describe("reasoningContent", () => {
		it("yields reasoning for reasoningContent.text", async () => {
			const chunks = [
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "nova reasoning" } } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "reasoning", reasoning: "nova reasoning" }])
		})

		it("does not yield when reasoningContent.text is empty", async () => {
			const chunks = [{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "" } } } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})
	})

	describe("text content", () => {
		it("yields text when no block type is set", async () => {
			const chunks = [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hello" } } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "text", text: "hello" }])
		})

		it("accumulates buffer across multiple text deltas", async () => {
			const chunks = [
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "a" } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "b" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			])
		})
	})

	describe("contentBlockStop cleanup", () => {
		it("cleans up block state so subsequent text deltas yield text not reasoning", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking" } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "reasoning text" } } },
				{ contentBlockStop: { contentBlockIndex: 0 } },
				// New block at same index after stop — should be treated as text
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "plain text" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([
				{ type: "reasoning", reasoning: "reasoning text" },
				{ type: "text", text: "plain text" },
			])
		})

		it("cleans up active tool calls on stop", async () => {
			const chunks = [
				{ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu-9", name: "bar" } } } },
				{ contentBlockStop: { contentBlockIndex: 0 } },
				// Tool input after stop — no active tool call, should not yield
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})
	})

	describe("error chunks", () => {
		it("yields text for internalServerException", async () => {
			const chunks = [{ internalServerException: { message: "boom" } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "text", text: "[ERROR] Internal server error: boom" }])
		})

		it("yields text for modelStreamErrorException", async () => {
			const chunks = [{ modelStreamErrorException: { message: "model failed" } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "text", text: "[ERROR] Model stream error: model failed" }])
		})

		it("yields text for throttlingException", async () => {
			const chunks = [{ throttlingException: { message: "slow down" } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "text", text: "[ERROR] Throttling error: slow down" }])
		})

		it("yields text for validationException (non-context error)", async () => {
			const chunks = [{ validationException: { message: "bad request" } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "text", text: "[ERROR] Validation error: bad request" }])
		})

		it("throws for context-window validationException", async () => {
			const chunks = [{ validationException: { message: "input is too long, context exceeds maximum" } }]
			await runStream(makeHandler(chunks), chunks).should.be.rejectedWith(/input is too long/)
		})

		it("yields text for serviceUnavailableException", async () => {
			const chunks = [{ serviceUnavailableException: { message: "down" } }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.deepEqual([{ type: "text", text: "[ERROR] Service unavailable: down" }])
		})
	})

	describe("edge cases", () => {
		it("yields nothing when stream is absent", async () => {
			const handler = new AwsBedrockHandler({})
			const fakeClient = { send: sinon.stub().resolves({}) }
			sinon.stub(handler as any, "getBedrockClient").resolves(fakeClient as any)
			sinon.stub(handler, "getModel").returns({ id: "x", info: ZERO_PRICE_MODEL })
			const out = await collect((handler as any).executeConverseStream({}, ZERO_PRICE_MODEL))
			out.should.have.length(0)
		})

		it("yields nothing for empty stream", async () => {
			const out = await runStream(makeHandler([]), [])
			out.should.have.length(0)
		})

		it("yields nothing for unrecognized chunk shapes", async () => {
			const chunks = [{ unknownField: "x" }, { another: 1 }]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(0)
		})

		it("handles interleaved metadata and content blocks in order", async () => {
			const chunks = [
				{ metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
				{ contentBlockStart: { contentBlockIndex: 0, start: { type: "thinking" } } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { thinking: "step" } } },
				{ contentBlockDelta: { contentBlockIndex: 1, delta: { text: "answer" } } },
			]
			const out = await runStream(makeHandler(chunks), chunks)
			out.should.have.length(3)
			out[0].type.should.equal("usage")
			out[1].should.deepEqual({ type: "reasoning", reasoning: "step" })
			out[2].should.deepEqual({ type: "text", text: "answer" })
		})
	})
})
