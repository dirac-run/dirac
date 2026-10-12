import "should"
import { expect } from "chai"
import {
	buildResponseCreateParams,
	getOpenAIServiceTier,
	normalizeOpenAIServiceTier,
	parseSseResponse,
	processResponsesEvents,
	shouldRetryWithFullContext,
	yieldUsage,
} from "../openai-responses-utils"

describe("yieldUsage", () => {
	it("does not bill reasoning tokens twice", async () => {
		const chunks: any[] = []
		for await (const chunk of yieldUsage(
			{ inputPrice: 1, outputPrice: 2 } as any,
			{
				input_tokens: 100,
				output_tokens: 30,
				output_tokens_details: { reasoning_tokens: 20 },
			},
		)) {
			chunks.push(chunk)
		}

		chunks.should.have.length(1)
		chunks[0].outputTokens.should.equal(30)
		chunks[0].reasoningTokens.should.equal(20)
		expect(chunks[0].totalCost).to.be.approximately(0.00016, 1e-12)
	})
})


describe("OpenAI service tiers", () => {
	it("maps configured speeds to native and Codex request tiers", () => {
		expect(getOpenAIServiceTier("default")).to.equal(undefined)
		expect(getOpenAIServiceTier("standard")).to.equal("default")
		expect(getOpenAIServiceTier("fast")).to.equal("fast")
		expect(getOpenAIServiceTier("fast", "priority")).to.equal("priority")
	})

	it("normalizes delivered service tiers", () => {
		expect(normalizeOpenAIServiceTier("fast")).to.equal("fast")
		expect(normalizeOpenAIServiceTier("priority")).to.equal("fast")
		expect(normalizeOpenAIServiceTier("default")).to.equal("standard")
		expect(normalizeOpenAIServiceTier("flex")).to.equal(undefined)
	})
})

describe("parseSseResponse", () => {
	it("rejects malformed complete SSE events", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {malformed}\n"))
				controller.close()
			},
		})

		await (async () => {
			for await (const _event of parseSseResponse(body)) {
				// no events expected
			}
		})().should.be.rejectedWith(SyntaxError)
	})

	it("finishes and cancels the reader when the server sends DONE without closing", async () => {
		let cancelled = false
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: [DONE]\n"))
			},
			cancel() {
				cancelled = true
			},
		})
		const iterator = parseSseResponse(body)[Symbol.asyncIterator]()
		let timeout: NodeJS.Timeout | undefined

		const result = await Promise.race([
			iterator.next(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("SSE parser did not stop at DONE")), 100)
			}),
		])
		if (timeout) clearTimeout(timeout)

		expect(result.done).to.equal(true)
		cancelled.should.equal(true)
	})
})

// Characterization tests for shouldRetryWithFullContext.
// The function decides whether a failed request should be retried with the full
// conversation context (no previous_response_id) — only when there was a previous
// response id AND the error indicates that id is no longer known to the server.
describe("shouldRetryWithFullContext", () => {
	it("returns false when there was no previous response id", () => {
		shouldRetryWithFullContext({ status: 404, message: "not found" }, false).should.equal(false)
	})

	it("returns true for previous_response_not_found error code", () => {
		shouldRetryWithFullContext({ code: "previous_response_not_found", message: "x" }, true).should.equal(true)
	})

	it("returns true when message contains previous_response_not_found", () => {
		shouldRetryWithFullContext(new Error("previous_response_not_found in stream"), true).should.equal(true)
	})

	it("returns true for HTTP 404 status", () => {
		shouldRetryWithFullContext({ status: 404, message: "missing" }, true).should.equal(true)
	})

	it("returns true when message contains 404 string", () => {
		shouldRetryWithFullContext(new Error("got 404 from server"), true).should.equal(true)
	})

	it("returns false for 404 with details.param === 'input' (item-level 404)", () => {
		shouldRetryWithFullContext({ status: 404, message: "missing", details: { param: "input" } }, true).should.equal(false)
	})

	it("does not retry websocket transport failures as full-context requests", () => {
		shouldRetryWithFullContext({ code: "websocket_closed", message: "x" }, true).should.equal(false)
		shouldRetryWithFullContext({ code: "websocket_error", message: "x" }, true).should.equal(false)
	})

	it("returns false for unrelated errors", () => {
		shouldRetryWithFullContext({ status: 500, message: "server error" }, true).should.equal(false)
	})
})

describe("buildResponseCreateParams", () => {
	const baseArgs = {
		modelId: "gpt-test",
		systemPrompt: "You are helpful.",
		input: [] as any,
		tools: [{ type: "function", name: "read_file", parameters: { type: "object" }, strict: true }] as any,
	}

	it("includes parallel_tool_calls when enabled", () => {
		const params = buildResponseCreateParams({ ...baseArgs, enableParallelToolCalling: true }) as any
		params.parallel_tool_calls.should.equal(true)
	})

	it("includes parallel_tool_calls when disabled", () => {
		const params = buildResponseCreateParams({ ...baseArgs, enableParallelToolCalling: false }) as any
		params.parallel_tool_calls.should.equal(false)
	})

	it("includes all-turn reasoning context only when explicitly requested", () => {
		const params = buildResponseCreateParams({ ...baseArgs, reasoningContext: "all_turns" }) as any
		params.reasoning.context.should.equal("all_turns")
	})

	it("stores a continued response when explicitly requested", () => {
		const params = buildResponseCreateParams({ ...baseArgs, previousResponseId: "resp_123", store: true }) as any
		params.store.should.equal(true)
	})

	it("includes the requested service tier", () => {
		const params = buildResponseCreateParams({ ...baseArgs, serviceTier: "fast" }) as any
		params.service_tier.should.equal("fast")
	})

	it("omits service_tier for provider default", () => {
		const params = buildResponseCreateParams(baseArgs) as any
		expect(params.service_tier).to.equal(undefined)
	})
})
describe("processResponsesEvents", () => {
	it("does not repeat completed function arguments after streaming deltas", async () => {
		async function* stream() {
			yield {
				type: "response.output_item.added",
				item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "" },
			}
			yield { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '{"path":' }
			yield { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '"a"}' }
			yield {
				type: "response.function_call_arguments.done",
				item_id: "item-1",
				name: "read_file",
				arguments: '{"path":"a"}',
			}
			yield {
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "item-1",
					call_id: "call-1",
					name: "read_file",
					arguments: '{"path":"a"}',
				},
			}
		}

		const argumentsChunks: string[] = []
		for await (const chunk of processResponsesEvents(stream() as any, {} as any)) {
			if (chunk.type === "tool_calls") argumentsChunks.push(chunk.tool_call.function.arguments ?? "")
		}

		argumentsChunks.join("").should.equal('{"path":"a"}')
	})

	it("emits final function arguments when no argument deltas arrive", async () => {
		async function* stream() {
			yield {
				type: "response.output_item.added",
				item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "" },
			}
			yield {
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "item-1",
					call_id: "call-1",
					name: "read_file",
					arguments: '{"path":"a"}',
				},
			}
		}

		const argumentsChunks: string[] = []
		for await (const chunk of processResponsesEvents(stream() as any, {} as any)) {
			if (chunk.type === "tool_calls") argumentsChunks.push(chunk.tool_call.function.arguments ?? "")
		}

		argumentsChunks.join("").should.equal('{"path":"a"}')
	})

	it("separates OpenAI reasoning summary parts into distinct paragraphs", async () => {
		async function* stream() {
			yield {
				type: "response.reasoning_summary_part.added",
				item_id: "reasoning-1",
				summary_index: 0,
				part: { text: "" },
			}
			yield {
				type: "response.reasoning_summary_text.delta",
				item_id: "reasoning-1",
				summary_index: 0,
				delta: "**Planning layout restoration**",
			}
			yield {
				type: "response.reasoning_summary_part.done",
				item_id: "reasoning-1",
				summary_index: 0,
				part: { text: "**Planning layout restoration**" },
			}
			yield {
				type: "response.reasoning_summary_part.added",
				item_id: "reasoning-1",
				summary_index: 1,
				part: { text: "" },
			}
			yield {
				type: "response.reasoning_summary_text.delta",
				item_id: "reasoning-1",
				summary_index: 1,
				delta: "**Refining spacing**",
			}
		}

		const chunks: any[] = []
		for await (const chunk of processResponsesEvents(stream() as any, {} as any)) chunks.push(chunk)

		const reasoning = chunks
			.filter((chunk) => chunk.type === "reasoning")
			.map((chunk) => chunk.reasoning)
			.join("")
		reasoning.should.equal("**Planning layout restoration**\n\n**Refining spacing**")
	})


	it("preserves structured metadata from error events", async () => {
		async function* stream() {
			yield {
				type: "error",
				message: "Your input exceeds the context window of this model.",
				code: "context_length_exceeded",
				status: 400,
				param: "input",
			}
		}

		let caughtError: any
		try {
			for await (const _chunk of processResponsesEvents(stream() as any, {} as any)) {
				// Error events do not produce output chunks.
			}
		} catch (error) {
			caughtError = error
		}

		expect(caughtError).to.be.instanceOf(Error)
		expect(caughtError.message).to.equal(
			"Codex API stream error: Your input exceeds the context window of this model.",
		)
		expect(caughtError.code).to.equal("context_length_exceeded")
		expect(caughtError.status).to.equal(400)
		expect(caughtError.details).to.deep.equal({ param: "input" })
	})


	it("reports completed response IDs to the caller", async () => {
		async function* stream() {
			yield { type: "response.completed", response: { id: "resp_123" } }
		}

		let completedResponseId: string | undefined
		for await (const _chunk of processResponsesEvents(stream() as any, {} as any, {
			onResponseCompleted: (response) => {
				completedResponseId = response.id
			},
		})) {
			// The response has no usage and therefore produces no output chunks.
		}

		expect(completedResponseId).to.equal("resp_123")
	})
})
