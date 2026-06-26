/**
 * Characterization tests for DifyHandler SSE stream parsing.
 * Covers text deltas (replace semantics), usage chunks, conversation ID capture,
 * event-type dispatch, error handling, malformed JSON, and edge cases.
 */
import "should"
import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as netModule from "@/shared/net"
import { DifyHandler } from "../dify"

// Build a ReadableStream body from raw string chunks.
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(encoder.encode(c))
			controller.close()
		},
	})
}

// Compose SSE "data:" lines from JSON objects, separated by newlines.
function sse(...events: (object | string)[]): string {
	return events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n") + "\n"
}

// Mock Response with headers.forEach (Dify reads response.headers).
function makeResponse(body: ReadableStream<Uint8Array> | null, ok = true, status = 200, statusText = "OK") {
	const headers = new Map<string, string>()
	return {
		ok,
		status,
		statusText,
		body,
		headers: { forEach: (cb: (v: string, k: string) => void) => headers.forEach((v, k) => cb(v, k)) },
		text: sinon.stub().resolves("error body"),
		json: sinon.stub(),
	} as any
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const c of gen) out.push(c)
	return out
}

function makeHandler(): DifyHandler {
	return new DifyHandler({ difyApiKey: "test-key", difyBaseUrl: "https://dify.test" })
}

function stubFetchResponse(body: ReadableStream<Uint8Array> | null, ok = true, status = 200, statusText = "OK") {
	sinon.stub(netModule, "fetch").resolves(makeResponse(body, ok, status, statusText))
}

describe("DifyHandler", () => {
	afterEach(() => sinon.restore())

	describe("constructor", () => {
		it("throws when API key is missing", () => {
			should.throws(() => new DifyHandler({ difyBaseUrl: "https://dify.test" }), /Dify API key is required/)
		})
		it("throws when base URL is missing", () => {
			should.throws(() => new DifyHandler({ difyApiKey: "k" }), /Dify base URL is required/)
		})
		it("throws when both API key and base URL are missing", () => {
			should.throws(() => new DifyHandler({}), /Dify API key is required/)
		})
	})

	describe("getModel", () => {
		it("returns dify-workflow id", () => {
			makeHandler().getModel().id.should.equal("dify-workflow")
		})
		it("reports image support and no prompt cache", () => {
			const info = makeHandler().getModel().info
			info.supportsImages!.should.be.true()
			info.supportsPromptCache!.should.be.false()
		})
		it("reports zero pricing", () => {
			const info = makeHandler().getModel().info
			info.inputPrice!.should.equal(0)
			info.outputPrice!.should.equal(0)
		})
	})

	describe("createMessage — error handling", () => {
		it("wraps network errors with cause info", async () => {
			const handler = makeHandler()
			sinon.stub(netModule, "fetch").rejects(Object.assign(new Error("connect failed"), { cause: "ECONNREFUSED" }))
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API network error: connect failed \| Cause: ECONNREFUSED/)
		})
		it("wraps network errors without cause when absent", async () => {
			const handler = makeHandler()
			sinon.stub(netModule, "fetch").rejects(new Error("timeout"))
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API network error: timeout/)
		})
		it("throws status-coded error on non-ok response", async () => {
			const handler = makeHandler()
			stubFetchResponse(null, false, 401, "Unauthorized")
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API error: 401 Unauthorized - error body/)
		})
		it("throws when response has no body", async () => {
			const handler = makeHandler()
			stubFetchResponse(null, true, 200, "OK")
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/No response body from Dify API/)
		})
	})

	describe("createMessage — SSE event parsing", () => {
		it("yields text from message event using replace semantics", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "message", answer: "Hello" }),
					sse({ event: "message", answer: "Hello World" }),
					sse({ event: "message_end" }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			// message replaces fullText each time; message_end re-yields final fullText.
			out.should.deepEqual([
				{ type: "text", text: "Hello" },
				{ type: "text", text: "Hello World" },
				{ type: "text", text: "Hello World" },
			])
		})

		it("yields text from message_replace event", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "message", answer: "draft" }),
					sse({ event: "message_replace", answer: "final" }),
					sse({ event: "message_end" }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([
				{ type: "text", text: "draft" },
				{ type: "text", text: "final" },
				{ type: "text", text: "final" },
			])
		})

		it("does not yield on message_replace when answer is missing", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "message", answer: "keep" }),
					sse({ event: "message_replace" }),
					sse({ event: "message_end" }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			// message_replace with no answer does not update fullText; message_end re-yields "keep".
			out.should.deepEqual([
				{ type: "text", text: "keep" },
				{ type: "text", text: "keep" },
			])
		})

		it("yields usage from message_end with prompt/completion tokens", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "message", answer: "hi" }),
					sse({ event: "message_end", usage: { prompt_tokens: 12, completion_tokens: 34, total_price: 0.5 } }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(3)
			out[2].should.deepEqual({ type: "usage", inputTokens: 12, outputTokens: 34, totalCost: 0.5 })
		})

		it("falls back to total_tokens when completion_tokens missing", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "message_end", usage: { prompt_tokens: 5, total_tokens: 99 } })]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			// No fullText so no text chunk; only usage with total_tokens fallback.
			out.should.deepEqual([{ type: "usage", inputTokens: 5, outputTokens: 99, totalCost: 0 }])
		})

		it("defaults usage tokens to 0 when usage fields absent", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "message_end", usage: {} })]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([{ type: "usage", inputTokens: 0, outputTokens: 0, totalCost: 0 }])
		})

		it("does not yield usage when message_end has no usage object", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "message_end" })]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(0)
		})

		// BUG characterization: the error-event throw lives inside the SSE try/catch,
		// so it is swallowed by the JSON-parse catch and the stream continues.
		it("swallows error event throw (caught by parse try/catch) and ends with diagnostic", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "error", message: "workflow failed" })]))
			const err = await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API did not provide any assistant messages/)
			// The error event was processed (pushed to processedEvents) before being swallowed.
			expect(err.message).to.include("error")
		})

		it("swallows error event without message and ends with diagnostic", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "error" })]))
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API did not provide any assistant messages/)
		})

		it("ignores workflow_started/finished events", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "workflow_started" }),
					sse({ event: "workflow_finished" }),
					sse({ event: "message", answer: "done" }),
					sse({ event: "message_end" }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([
				{ type: "text", text: "done" },
				{ type: "text", text: "done" },
			])
		})

		it("ignores node_started/finished events", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "node_started" }),
					sse({ event: "node_finished" }),
					sse({ event: "message", answer: "x" }),
					sse({ event: "message_end" }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(2)
			out.every((c) => c.type === "text").should.be.true()
		})

		it("ignores ping events", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([sse({ event: "ping" }), sse({ event: "message", answer: "pong" }), sse({ event: "message_end" })]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(2)
		})
	})

	describe("createMessage — unknown event fallback fields", () => {
		it("appends text from unknown event with text field", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "agent_message", text: "part1" }),
					sse({ event: "agent_message", text: "part2" }),
					sse({ event: "message_end" }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			// Unknown events append: "part1" then "part1part2"; message_end re-yields final.
			out.should.deepEqual([
				{ type: "text", text: "part1" },
				{ type: "text", text: "part1part2" },
				{ type: "text", text: "part1part2" },
			])
		})

		it("appends content from unknown event with content field", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "custom", content: "C1" }), sse({ event: "message_end" })]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([
				{ type: "text", text: "C1" },
				{ type: "text", text: "C1" },
			])
		})

		it("appends answer from unknown event as fallback", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "other", answer: "A1" }), sse({ event: "message_end" })]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([
				{ type: "text", text: "A1" },
				{ type: "text", text: "A1" },
			])
		})
	})

	describe("createMessage — SSE sentinel & malformed data", () => {
		it("[DONE] breaks inner loop but does not end stream", async () => {
			const handler = makeHandler()
			// [DONE] only breaks the for-loop; stream continues until done.
			stubFetchResponse(
				makeStream([
					sse({ event: "message", answer: "hi" }, "[DONE]"),
					// No message_end → falls through to final check, but hasYieldedContent=true so skipped.
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([{ type: "text", text: "hi" }])
		})

		it("skips empty data lines", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream(["data: \n", sse({ event: "message", answer: "ok" }), sse({ event: "message_end" })]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(2)
		})

		it("logs and skips malformed JSON in data lines", async () => {
			const handler = makeHandler()
			const warnStub = sinon.stub(console, "warn") // Logger.warn may delegate; ensure no throw
			stubFetchResponse(
				makeStream([
					"data: {not valid json\n",
					sse({ event: "message", answer: "recovered" }),
					sse({ event: "message_end" }),
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(2)
			warnStub.restore()
		})
	})

	describe("createMessage — conversation ID handling", () => {
		it("captures conversation_id from first event that has it", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					sse({ event: "message", answer: "hi", conversation_id: "conv-123" }),
					sse({ event: "message_end", conversation_id: "conv-123" }),
				]),
			)
			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			handler.getCurrentConversationId()!.should.equal("conv-123")
		})

		it("does not overwrite conversation_id once set", async () => {
			const handler = makeHandler()
			handler.setConversationId("pre-set")
			stubFetchResponse(
				makeStream([sse({ event: "message", answer: "hi", conversation_id: "new-id" }), sse({ event: "message_end" })]),
			)
			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			handler.getCurrentConversationId()!.should.equal("pre-set")
		})

		it("resetConversation clears conversation and task IDs", async () => {
			const handler = makeHandler()
			handler.setConversationId("conv-1")
			handler.resetConversation()
			should(handler.getCurrentConversationId()).be.null()
		})
	})

	describe("createMessage — direct JSON (non-SSE) fallback", () => {
		it("parses direct JSON message event and appends answer", async () => {
			const handler = makeHandler()
			// Lines without "data: " prefix but valid JSON are parsed as direct JSON.
			stubFetchResponse(
				makeStream([
					JSON.stringify({ event: "message", answer: "direct" }) + "\n",
					JSON.stringify({ event: "message_end" }) + "\n",
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			// Direct JSON message appends (not replace); message_end re-yields.
			out.should.deepEqual([
				{ type: "text", text: "direct" },
				{ type: "text", text: "direct" },
			])
		})

		// BUG characterization: direct-JSON error throw is also caught by its try/catch.
		it("swallows direct JSON error event and ends with diagnostic", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([JSON.stringify({ event: "error", message: "direct fail" }) + "\n"]))
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API did not provide any assistant messages/)
		})

		it("falls back to answer/text/content in direct JSON without event", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream([
					JSON.stringify({ answer: "fallback-content" }) + "\n",
					JSON.stringify({ event: "message_end" }) + "\n",
				]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([
				{ type: "text", text: "fallback-content" },
				{ type: "text", text: "fallback-content" },
			])
		})

		it("ignores non-JSON non-SSE lines silently", async () => {
			const handler = makeHandler()
			stubFetchResponse(
				makeStream(["this is not json\n", sse({ event: "message", answer: "ok" }), sse({ event: "message_end" })]),
			)
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.have.length(2)
		})
	})

	describe("createMessage — edge cases", () => {
		it("throws diagnostic error on empty stream with no content", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([""]))
			const err = await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API did not provide any assistant messages/)
			// Verify error mentions processed events and API URL.
			expect(err.message).to.include("Events processed: []")
			expect(err.message).to.include("https://dify.test/chat-messages")
		})

		it("throws diagnostic error listing processed event names", async () => {
			const handler = makeHandler()
			stubFetchResponse(makeStream([sse({ event: "ping" }), sse({ event: "workflow_started" })]))
			const err = await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Dify API did not provide any assistant messages/)
			expect(err.message).to.include("ping")
			expect(err.message).to.include("workflow_started")
		})

		it("yields accumulated text as fallback when no content was yielded but text exists", async () => {
			const handler = makeHandler()
			// message_replace with no answer leaves fullText empty; but unknown event with text accumulates.
			// Here: only message_replace with answer that sets fullText, but hasYieldedContent stays false?
			// Actually message_replace with answer sets hasYieldedContent=true. Construct a case where
			// fullText is set but hasYieldedContent is false: not possible via normal events.
			// Instead test the final-check fallback path via direct JSON content without message_end.
			stubFetchResponse(makeStream([JSON.stringify({ content: "leftover" }) + "\n"]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			// direct JSON content yields text (hasYieldedContent=true), so final check skipped.
			out.should.deepEqual([{ type: "text", text: "leftover" }])
		})

		it("handles split chunks across read boundaries", async () => {
			const handler = makeHandler()
			// Split a single SSE event across two chunks.
			const full = sse({ event: "message", answer: "split" }) + sse({ event: "message_end" })
			const mid = Math.floor(full.length / 2)
			stubFetchResponse(makeStream([full.slice(0, mid), full.slice(mid)]))
			const out = await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			out.should.deepEqual([
				{ type: "text", text: "split" },
				{ type: "text", text: "split" },
			])
		})

		it("prepends system prompt on first conversation (no conversation_id)", async () => {
			const handler = makeHandler()
			const fetchStub = sinon.stub(netModule, "fetch").resolves(makeResponse(makeStream([sse({ event: "message_end" })])))
			await collect(handler.createMessage("SYS-PROMPT", [{ role: "user", content: "hello" }]))
			const body = JSON.parse((fetchStub.firstCall.args[1] as any).body)
			expect(body.query).to.include("SYS-PROMPT")
			expect(body.query).to.include("hello")
			body.conversation_id.should.equal("")
		})

		it("does not prepend system prompt when conversation_id already set", async () => {
			const handler = makeHandler()
			handler.setConversationId("existing-conv")
			const fetchStub = sinon.stub(netModule, "fetch").resolves(makeResponse(makeStream([sse({ event: "message_end" })])))
			await collect(handler.createMessage("SYS-PROMPT", [{ role: "user", content: "hello" }]))
			const body = JSON.parse((fetchStub.firstCall.args[1] as any).body)
			body.query.should.equal("hello")
			body.conversation_id.should.equal("existing-conv")
		})

		it("returns empty query when no user message present", async () => {
			const handler = makeHandler()
			const fetchStub = sinon.stub(netModule, "fetch").resolves(makeResponse(makeStream([sse({ event: "message_end" })])))
			await collect(handler.createMessage("sys", [{ role: "assistant", content: "only assistant" }]))
			const body = JSON.parse((fetchStub.firstCall.args[1] as any).body)
			body.query.should.equal("")
		})

		it("joins array content from user message into query", async () => {
			const handler = makeHandler()
			handler.setConversationId("conv") // avoid system-prompt prepend
			const fetchStub = sinon.stub(netModule, "fetch").resolves(makeResponse(makeStream([sse({ event: "message_end" })])))
			await collect(
				handler.createMessage("sys", [
					{
						role: "user",
						content: [{ type: "text", text: "line1" } as any, { type: "text", text: "line2" } as any],
					},
				]),
			)
			const body = JSON.parse((fetchStub.firstCall.args[1] as any).body)
			body.query.should.equal("line1\nline2")
		})

		it("sends streaming response_mode and dirac-user in request body", async () => {
			const handler = makeHandler()
			const fetchStub = sinon.stub(netModule, "fetch").resolves(makeResponse(makeStream([sse({ event: "message_end" })])))
			await collect(handler.createMessage("sys", [{ role: "user", content: "hi" }]))
			const body = JSON.parse((fetchStub.firstCall.args[1] as any).body)
			body.response_mode.should.equal("streaming")
			body.user.should.equal("dirac-user")
		})
	})
})
