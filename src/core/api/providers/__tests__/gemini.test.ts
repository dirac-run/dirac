import "should"
import { ApiError } from "@google/genai"
import { TEST_MODEL_IDS } from "@test/fixtures/model-ids"
import { expect } from "chai"
import sinon from "sinon"
import { RetriableError } from "../../retry"
import { GeminiHandler } from "../gemini"

describe("GeminiHandler", () => {
	afterEach(() => {
		sinon.restore()
	})

	const createAsyncIterable = (data: any[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	it("caps maxOutputTokens to 32768 for Flash models", async () => {
		const handler = new GeminiHandler({
			geminiApiKey: "test-api-key",
			apiModelId: TEST_MODEL_IDS.GEMINI_FLASH,
		})

		const generateContentStream = sinon.stub().resolves(
			createAsyncIterable([
				{
					responseId: "resp-1",
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 20,
						cachedContentTokenCount: 0,
						thoughtsTokenCount: 0,
					},
				},
			]),
		)
		sinon.stub(handler as any, "ensureClient").returns({
			models: { generateContentStream },
		} as any)

		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
			// Consume stream to trigger request execution.
		}

		const requestArgs = generateContentStream.firstCall.args[0] as Record<string, any>
		requestArgs.config.should.have.property("maxOutputTokens", 32_768)
	})

	it("sets maxOutputTokens for non-Flash models", async () => {
		const handler = new GeminiHandler({
			geminiApiKey: "test-api-key",
			apiModelId: TEST_MODEL_IDS.GEMINI,
		})

		const generateContentStream = sinon.stub().resolves(
			createAsyncIterable([
				{
					responseId: "resp-2",
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 20,
						cachedContentTokenCount: 0,
						thoughtsTokenCount: 0,
					},
				},
			]),
		)
		sinon.stub(handler as any, "ensureClient").returns({
			models: { generateContentStream },
		} as any)

		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
			// Consume stream to trigger request execution.
		}

		const requestArgs = generateContentStream.firstCall.args[0] as Record<string, any>
		requestArgs.config.should.have.property("maxOutputTokens", 32_768)
	})

	it("should emit unique tool call IDs when multiple function calls share one responseId", async () => {
		const handler = new GeminiHandler({
			geminiApiKey: "test-api-key",
		})

		const fakeClient = {
			models: {
				generateContentStream: sinon.stub().resolves(
					createAsyncIterable([
						{
							responseId: "resp_1",
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: {
													name: "read_file",
													args: { path: ".nvmrc" },
												},
											},
										],
									},
								},
							],
						},
						{
							responseId: "resp_1",
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: {
													name: "read_file",
													args: { path: ".gitattributes" },
												},
											},
										],
									},
								},
							],
						},
					]),
				),
			},
		}
		sinon.stub(handler as any, "ensureClient").returns(fakeClient as any)

		const tools = [{ name: "read_file", description: "read file", parameters: { type: "OBJECT" } }] as any
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
			if (chunk.type === "tool_calls") {
				chunks.push(chunk)
			}
		}

		chunks.should.have.length(2)
		chunks[0].tool_call.function.id.should.equal("resp_1-tool-0")
		chunks[1].tool_call.function.id.should.equal("resp_1-tool-1")
		chunks[0].tool_call.call_id.should.equal(chunks[0].tool_call.function.id)
		chunks[1].tool_call.call_id.should.equal(chunks[1].tool_call.function.id)
		JSON.parse(chunks[0].tool_call.function.arguments).path.should.equal(".nvmrc")
		JSON.parse(chunks[1].tool_call.function.arguments).path.should.equal(".gitattributes")
	})

	it("should preserve Gemini-provided functionCall.id when present", async () => {
		const handler = new GeminiHandler({
			geminiApiKey: "test-api-key",
		})

		const fakeClient = {
			models: {
				generateContentStream: sinon.stub().resolves(
					createAsyncIterable([
						{
							responseId: "resp_2",
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: {
													id: "call_alpha",
													name: "read_file",
													args: { path: ".nvmrc" },
												},
											},
										],
									},
								},
							],
						},
					]),
				),
			},
		}
		sinon.stub(handler as any, "ensureClient").returns(fakeClient as any)

		const tools = [{ name: "read_file", description: "read file", parameters: { type: "OBJECT" } }] as any
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
			if (chunk.type === "tool_calls") {
				chunks.push(chunk)
			}
		}

		chunks.should.have.length(1)
		chunks[0].tool_call.function.id.should.equal("call_alpha")
		chunks[0].tool_call.call_id.should.equal("call_alpha")
		JSON.parse(chunks[0].tool_call.function.arguments).path.should.equal(".nvmrc")
	})

	describe("stream parsing", () => {
		it("should yield text chunks for part.text deltas", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ text: "Hello " }] } }],
					},
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ text: "world" }] } }],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 2,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const textChunks = chunks.filter((c) => c.type === "text")
			textChunks.should.have.length(2)
			textChunks[0].text.should.equal("Hello ")
			textChunks[1].text.should.equal("world")
			textChunks[0].id.should.equal("r1")
		})

		it("should yield reasoning chunks for thought parts with text", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ thought: true, text: "Thinking about this..." }] } }],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 1,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 10,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const reasoningChunks = chunks.filter((c) => c.type === "reasoning")
			reasoningChunks.should.have.length(1)
			reasoningChunks[0].reasoning.should.equal("Thinking about this...")
			reasoningChunks[0].id.should.equal("r1")
		})

		it("should not yield reasoning when thought is true but text is empty", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ thought: true }] } }],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 0,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			chunks.filter((c) => c.type === "reasoning").should.have.length(0)
			chunks.filter((c) => c.type === "text").should.have.length(0)
		})

		it("should yield a usage chunk with cost and token breakdown at stream end", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key", apiModelId: TEST_MODEL_IDS.GEMINI })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ text: "response" }] } }],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 100,
							candidatesTokenCount: 50,
							cachedContentTokenCount: 30,
							thoughtsTokenCount: 5,
						},
						candidates: [{ finishReason: "STOP" }],
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const usageChunks = chunks.filter((c) => c.type === "usage")
			usageChunks.should.have.length(1)
			const usage = usageChunks[0]
			// inputTokens subtracts cacheReadTokens from promptTokens
			usage.inputTokens.should.equal(70)
			usage.outputTokens.should.equal(50)
			usage.cacheReadTokens.should.equal(30)
			usage.cacheWriteTokens.should.equal(0)
			usage.reasoningTokens.should.equal(5)
			usage.stopReason.should.equal("STOP")
			usage.id.should.equal("r1")
			// cost: gemini-2.5-pro tier 1 (<=200k): inputPrice=1.25, outputPrice=10, cacheReadsPrice=0.31
			// uncachedInput=70, output+thoughts=55, cacheRead=30
			const expectedCost = (1.25 * 70 + 10 * 55 + 0.31 * 30) / 1_000_000
			usage.totalCost.should.be.approximately(expectedCost, 1e-9)
		})

		it("should use the last usageMetadata when multiple chunks carry usage", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key", apiModelId: TEST_MODEL_IDS.GEMINI })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 10,
							candidatesTokenCount: 5,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 100,
							candidatesTokenCount: 50,
							cachedContentTokenCount: 20,
							thoughtsTokenCount: 8,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const usage = chunks.find((c) => c.type === "usage")
			usage.inputTokens.should.equal(80)
			usage.outputTokens.should.equal(50)
			usage.cacheReadTokens.should.equal(20)
			usage.reasoningTokens.should.equal(8)
		})

		it("should propagate thoughtSignature from earlier parts to later text parts", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ thought: true, text: "thinking", thoughtSignature: "sig-123" }] } }],
					},
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ text: "answer" }] } }],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 1,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const reasoning = chunks.find((c) => c.type === "reasoning")
			reasoning.signature.should.equal("sig-123")
			const text = chunks.find((c) => c.type === "text")
			text.signature.should.equal("sig-123")
		})
	})

	describe("tool conversion", () => {
		it("should serialize functionCall args to JSON string", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [
							{ content: { parts: [{ functionCall: { name: "search", args: { query: "test", limit: 10 } } }] } },
						],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 1,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const tools = [{ name: "search", description: "search", parameters: { type: "OBJECT" } }] as any
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
				if (chunk.type === "tool_calls") chunks.push(chunk)
			}

			chunks.should.have.length(1)
			const parsed = JSON.parse(chunks[0].tool_call.function.arguments)
			parsed.query.should.equal("test")
			parsed.limit.should.equal(10)
			chunks[0].tool_call.function.name.should.equal("search")
		})

		it("should default functionCall args to empty object when args is undefined", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [{ content: { parts: [{ functionCall: { name: "noop" } }] } }],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 1,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const tools = [{ name: "noop", description: "noop", parameters: { type: "OBJECT" } }] as any
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
				if (chunk.type === "tool_calls") chunks.push(chunk)
			}

			chunks.should.have.length(1)
			chunks[0].tool_call.function.arguments.should.equal("{}")
		})

		it("should handle mixed text and functionCall parts in a single chunk", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [
							{
								content: {
									parts: [
										{ text: "Let me read that file." },
										{ functionCall: { name: "read_file", args: { path: "/tmp" } } },
									],
								},
							},
						],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 5,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const tools = [{ name: "read_file", description: "read", parameters: { type: "OBJECT" } }] as any
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
				chunks.push(chunk)
			}

			chunks.filter((c) => c.type === "text").should.have.length(1)
			chunks.filter((c) => c.type === "tool_calls").should.have.length(1)
			chunks[0].type.should.equal("text")
			chunks[1].type.should.equal("tool_calls")
		})

		it("should handle multiple function calls in a single chunk with sequential IDs", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r_multi",
						candidates: [
							{
								content: {
									parts: [
										{ functionCall: { name: "tool_a", args: {} } },
										{ functionCall: { name: "tool_b", args: {} } },
										{ functionCall: { name: "tool_c", args: {} } },
									],
								},
							},
						],
					},
					{
						responseId: "r_multi",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 3,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const tools = [{ name: "tool_a", description: "a", parameters: { type: "OBJECT" } }] as any
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
				if (chunk.type === "tool_calls") chunks.push(chunk)
			}

			chunks.should.have.length(3)
			chunks[0].tool_call.function.id.should.equal("r_multi-tool-0")
			chunks[1].tool_call.function.id.should.equal("r_multi-tool-1")
			chunks[2].tool_call.function.id.should.equal("r_multi-tool-2")
			chunks[0].tool_call.function.name.should.equal("tool_a")
			chunks[1].tool_call.function.name.should.equal("tool_b")
			chunks[2].tool_call.function.name.should.equal("tool_c")
		})
	})

	describe("edge cases", () => {
		it("should emit no chunks for an empty stream", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(createAsyncIterable([]))
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			chunks.should.have.length(0)
		})

		it("should skip chunks with no candidates or parts", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{ responseId: "r1" },
					{ responseId: "r2", candidates: [] },
					{ responseId: "r3", candidates: [{ content: { parts: [] } }] },
					{
						responseId: "r3",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 0,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			// Only the usage chunk should be emitted
			chunks.should.have.length(1)
			chunks[0].type.should.equal("usage")
		})

		it("should not emit usage chunk when no usageMetadata is present in any chunk", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon
				.stub()
				.resolves(createAsyncIterable([{ responseId: "r1", candidates: [{ content: { parts: [{ text: "hello" }] } }] }]))
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			chunks.filter((c) => c.type === "usage").should.have.length(0)
			chunks.filter((c) => c.type === "text").should.have.length(1)
		})

		it("should preserve prior token counts when usageMetadata fields are missing", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key", apiModelId: TEST_MODEL_IDS.GEMINI })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 100,
							candidatesTokenCount: 50,
							cachedContentTokenCount: 30,
							thoughtsTokenCount: 5,
						},
					},
					// Second usage chunk missing all fields — prior values should persist
					{ responseId: "r1", usageMetadata: {} },
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const usage = chunks.find((c) => c.type === "usage")
			usage.inputTokens.should.equal(70)
			usage.outputTokens.should.equal(50)
			usage.cacheReadTokens.should.equal(30)
			usage.reasoningTokens.should.equal(5)
		})

		it("should emit grounding sources markdown after usage when groundingChunks present", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [
							{
								content: { parts: [{ text: "Here is the answer." }] },
								groundingMetadata: {
									groundingChunks: [
										{ web: { title: "Source A", uri: "https://a.com" } },
										{ web: { title: "Source B", uri: "https://b.com" } },
									],
								},
							},
						],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 5,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const textChunks = chunks.filter((c) => c.type === "text")
			textChunks.should.have.length(2)
			expect(textChunks[1].text).to.include("**Sources:**")
			expect(textChunks[1].text).to.include("https://a.com")
			expect(textChunks[1].text).to.include("https://b.com")
			expect(textChunks[1].text).to.include("Source A")
		})

		it("should not emit grounding sources when groundingChunks is empty", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						responseId: "r1",
						candidates: [
							{
								content: { parts: [{ text: "answer" }] },
								groundingMetadata: { groundingChunks: [] },
							},
						],
					},
					{
						responseId: "r1",
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 1,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
				chunks.push(chunk)
			}

			const textChunks = chunks.filter((c) => c.type === "text")
			textChunks.should.have.length(1)
			textChunks[0].text.should.equal("answer")
		})

		it("should use 'gemini-response' as responseKey when responseId is missing", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().resolves(
				createAsyncIterable([
					{
						// No responseId
						candidates: [{ content: { parts: [{ functionCall: { name: "tool_x", args: {} } }] } }],
					},
					{
						usageMetadata: {
							promptTokenCount: 5,
							candidatesTokenCount: 1,
							cachedContentTokenCount: 0,
							thoughtsTokenCount: 0,
						},
					},
				]),
			)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			const tools = [{ name: "tool_x", description: "x", parameters: { type: "OBJECT" } }] as any
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
				if (chunk.type === "tool_calls") chunks.push(chunk)
			}

			chunks.should.have.length(1)
			chunks[0].tool_call.function.id.should.equal("gemini-response-tool-0")
		})
	})

	describe("error handling", () => {
		it("should rethrow a generic Error immediately without retry", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().rejects(new Error("network failure"))
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			let caught: any
			try {
				for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
					// consume
				}
			} catch (e) {
				caught = e
			}

			expect(caught).to.be.instanceOf(Error)
			caught.message.should.equal("network failure")
			// Non-rate-limit errors are not retried
			generateContentStream.callCount.should.equal(1)
		})

		it("should rethrow a non-429 ApiError immediately", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const apiError = new ApiError({ message: "bad request", status: 400 })
			const generateContentStream = sinon.stub().rejects(apiError)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			let caught: any
			try {
				for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
					// consume
				}
			} catch (e) {
				caught = e
			}

			expect(caught).to.be.instanceOf(ApiError)
			caught.status.should.equal(400)
			generateContentStream.callCount.should.equal(1)
		})

		it("should throw RetriableError for 429 ApiError after exhausting retries", async () => {
			const clock = sinon.useFakeTimers()
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const apiError = new ApiError({ message: "rate limit exceeded", status: 429 })
			const generateContentStream = sinon.stub().rejects(apiError)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			let caught: any
			const consume = (async () => {
				try {
					for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
						// consume
					}
				} catch (e) {
					caught = e
				}
			})()

			await clock.tickAsync(30000)
			await consume

			expect(caught).to.be.instanceOf(RetriableError)
			// 4 retry attempts (maxRetries=4)
			generateContentStream.callCount.should.equal(4)
			clock.restore()
		})

		it("should throw RetriableError when error message matches rate limit patterns but status is not 429", async () => {
			const clock = sinon.useFakeTimers()
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			// ApiError with non-429 status but message containing rate-limit pattern
			const apiError = new ApiError({ message: "429 Too Many Requests", status: 503 })
			const generateContentStream = sinon.stub().rejects(apiError)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			let caught: any
			const consume = (async () => {
				try {
					for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
						// consume
					}
				} catch (e) {
					caught = e
				}
			})()

			await clock.tickAsync(30000)
			await consume

			expect(caught).to.be.instanceOf(RetriableError)
			clock.restore()
		})

		it("should parse RetryInfo retryDelay from nested 429 error message", async () => {
			const clock = sinon.useFakeTimers()
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			// Nested JSON: outer {error:{message: innerJSON}} where innerJSON has RetryInfo detail
			const innerError = JSON.stringify({
				error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] },
			})
			const outerMessage = JSON.stringify({ error: { message: innerError } })
			const apiError = new ApiError({ message: outerMessage, status: 429 })
			const generateContentStream = sinon.stub().rejects(apiError)
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			let caught: any
			const consume = (async () => {
				try {
					for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
						// consume
					}
				} catch (e) {
					caught = e
				}
			})()

			await clock.tickAsync(30000)
			await consume

			expect(caught).to.be.instanceOf(RetriableError)
			caught.retryAfter.should.equal(7)
			clock.restore()
		})

		it("should rethrow non-Error thrown values as-is", async () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const generateContentStream = sinon.stub().rejects("string error")
			sinon.stub(handler as any, "ensureClient").returns({ models: { generateContentStream } } as any)

			let caught: any
			try {
				for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
					// consume
				}
			} catch (e) {
				caught = e
			}

			String(caught).should.equal("string error")
			generateContentStream.callCount.should.equal(1)
		})
	})

	describe("calculateCost", () => {
		it("should return undefined when inputPrice is missing", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const cost = handler.calculateCost({
				info: { inputPrice: 0, outputPrice: 10 } as any,
				inputTokens: 100,
				outputTokens: 50,
				thoughtsTokenCount: 0,
			})
			expect(cost).to.be.undefined
		})

		it("should return undefined when outputPrice is missing", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const cost = handler.calculateCost({
				info: { inputPrice: 5, outputPrice: 0 } as any,
				inputTokens: 100,
				outputTokens: 50,
				thoughtsTokenCount: 0,
			})
			expect(cost).to.be.undefined
		})

		it("should include thoughtsTokenCount in output cost", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const cost = handler.calculateCost({
				info: { inputPrice: 1, outputPrice: 2 } as any,
				inputTokens: 1000,
				outputTokens: 500,
				thoughtsTokenCount: 200,
				cacheReadTokens: 0,
			})
			// output cost = 2 * (500 + 200) / 1_000_000
			const expected = (1 * 1000 + 2 * 700) / 1_000_000
			cost!.should.be.approximately(expected, 1e-12)
		})

		it("should subtract cacheReadTokens from input tokens for cost", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const cost = handler.calculateCost({
				info: { inputPrice: 1, outputPrice: 2, cacheReadsPrice: 0.5 } as any,
				inputTokens: 1000,
				outputTokens: 500,
				thoughtsTokenCount: 0,
				cacheReadTokens: 400,
			})
			// uncached input = 600, cache read cost = 0.5 * 400 / 1M
			const expected = (1 * 600 + 2 * 500 + 0.5 * 400) / 1_000_000
			cost!.should.be.approximately(expected, 1e-12)
		})

		it("should use tiered pricing when input tokens fall within a tier", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const cost = handler.calculateCost({
				info: {
					inputPrice: 4,
					outputPrice: 18,
					cacheReadsPrice: 0.4,
					tiers: [
						{ contextWindow: 200000, inputPrice: 2, outputPrice: 12, cacheReadsPrice: 0.2 },
						{ contextWindow: Number.POSITIVE_INFINITY, inputPrice: 4, outputPrice: 18, cacheReadsPrice: 0.4 },
					],
				} as any,
				inputTokens: 100000,
				outputTokens: 50000,
				thoughtsTokenCount: 0,
				cacheReadTokens: 0,
			})
			// 100k <= 200k tier: inputPrice=2, outputPrice=12
			const expected = (2 * 100000 + 12 * 50000) / 1_000_000
			cost!.should.be.approximately(expected, 1e-9)
		})
	})

	describe("getModel", () => {
		it("should return the specified model when apiModelId is valid", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key", apiModelId: TEST_MODEL_IDS.GEMINI_FLASH })
			const result = handler.getModel()
			result.id.should.equal(TEST_MODEL_IDS.GEMINI_FLASH)
		})

		it("should fall back to default model when apiModelId is not in geminiModels", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key", apiModelId: "nonexistent-model" })
			const result = handler.getModel()
			result.id.should.equal("gemini-3.1-pro-preview")
		})

		it("should fall back to default model when apiModelId is not set", () => {
			const handler = new GeminiHandler({ geminiApiKey: "test-api-key" })
			const result = handler.getModel()
			result.id.should.equal("gemini-3.1-pro-preview")
		})
	})
})
