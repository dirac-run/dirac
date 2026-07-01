import "should"
import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import * as copilotApi from "@/integrations/github-copilot/api"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"
import * as netModule from "@/shared/net"
import { GithubCopilotHandler } from "../github-copilot"
import { expectLoggerErrors } from "@/test/loggerGuard"

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

function makeResponse(body: ReadableStream<Uint8Array> | null, ok = true, status = 200, statusText = "OK") {
	return { ok, status, statusText, body, text: sinon.stub().resolves("error body"), json: sinon.stub() } as any
}

// Stubs shared across createMessage tests; returns the fetch stub for URL assertions.
function stubAuthAndToken() {
	sinon.stub(githubCopilotAuthManager, "getAccessToken").resolves("gh-token")
	sinon.stub(copilotApi, "getCopilotToken").resolves("copilot-token")
}

describe("GithubCopilotHandler", () => {
	afterEach(() => sinon.restore())

	describe("getModel", () => {
		it("should default to gpt-4o when no model id is configured", () => {
			new GithubCopilotHandler({} as any).getModel().id.should.equal("gpt-4o")
		})

		it("should return the configured model id", () => {
			new GithubCopilotHandler({ apiModelId: "claude-sonnet-4" } as any).getModel().id.should.equal("claude-sonnet-4")
		})

		it("should always set the GitHub Copilot description", () => {
			new GithubCopilotHandler({ apiModelId: "gpt-5" } as any)
				.getModel()
				.info.description!.should.equal("GitHub Copilot Native API")
		})
	})

	describe("createMessage — auth & error handling", () => {
		it("should throw when not authenticated (no access token)", async () => {
			const handler = new GithubCopilotHandler({} as any)
			sinon.stub(githubCopilotAuthManager, "getAccessToken").resolves(null)
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith("Not authenticated with GitHub Copilot. Please sign in.")
		})

		it("should throw a status-coded error when the API response is not ok", async () => {
			const handler = new GithubCopilotHandler({} as any)
			stubAuthAndToken()
			sinon.stub(copilotApi, "fetchCopilotModels").resolves([])
			sinon.stub(netModule, "fetch").resolves(makeResponse(null, false, 429, "Too Many Requests"))
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith("GitHub Copilot API error: 429 Too Many Requests - error body")
		})

		it("should throw when the response has no body", async () => {
			const handler = new GithubCopilotHandler({} as any)
			stubAuthAndToken()
			sinon.stub(copilotApi, "fetchCopilotModels").resolves([])
			sinon.stub(netModule, "fetch").resolves(makeResponse(null, true, 200, "OK"))
			await handler
				.createMessage("sys", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith("No response body from GitHub Copilot API")
		})

		it("should fall back to OpenAI format when fetchCopilotModels throws", async () => {
			expectLoggerErrors()
			const handler = new GithubCopilotHandler({} as any)
			stubAuthAndToken()
			sinon.stub(copilotApi, "fetchCopilotModels").rejects(new Error("network down"))
			sinon
				.stub(netModule, "fetch")
				.resolves(makeResponse(makeStream([sse({ choices: [{ delta: { content: "hello" } }] })])))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "text", text: "hello" }])
			sinon.assert.calledWithMatch(netModule.fetch as any, "https://api.githubcopilot.com/chat/completions")
		})
	})

	describe("createMessage — OpenAI format stream parsing", () => {
		function setupOpenAi(body: ReadableStream<Uint8Array>) {
			const handler = new GithubCopilotHandler({} as any)
			stubAuthAndToken()
			sinon.stub(copilotApi, "fetchCopilotModels").resolves([])
			sinon.stub(netModule, "fetch").resolves(makeResponse(body))
			return handler
		}

		it("should yield text deltas from content", async () => {
			const handler = setupOpenAi(
				makeStream([sse({ choices: [{ delta: { content: "foo" } }] }, { choices: [{ delta: { content: "bar" } }] })]),
			)
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([
				{ type: "text", text: "foo" },
				{ type: "text", text: "bar" },
			])
		})

		it("should yield usage chunks from prompt_tokens / completion_tokens", async () => {
			const handler = setupOpenAi(makeStream([sse({ usage: { prompt_tokens: 12, completion_tokens: 3 } })]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "usage", inputTokens: 12, outputTokens: 3 }])
		})

		it("should default missing usage tokens to 0", async () => {
			const handler = setupOpenAi(makeStream([sse({ usage: {} })]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "usage", inputTokens: 0, outputTokens: 0 }])
		})

		it("should yield tool_calls when a complete tool call delta arrives", async () => {
			const startEvt = {
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
							],
						},
					},
				],
			}
			const argEvt = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }] } }] }
			const handler = setupOpenAi(makeStream([sse(startEvt, argEvt)]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			// ToolCallProcessor yields once per delta that has id+name+arguments defined
			chunks.length.should.equal(2)
			chunks.forEach((c) => c.type.should.equal("tool_calls"))
			chunks[0].tool_call.call_id.should.equal("call_1")
			chunks[0].tool_call.function.name.should.equal("get_weather")
			chunks[0].tool_call.function.arguments.should.equal("")
			chunks[1].tool_call.call_id.should.equal("call_1")
			chunks[1].tool_call.function.name.should.equal("get_weather")
			expect(chunks[1].tool_call.function.arguments).to.include('"city":"SF"')
		})

		it("should ignore the [DONE] sentinel", async () => {
			const handler = setupOpenAi(makeStream([sse({ choices: [{ delta: { content: "done" } }] }, "[DONE]")]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "text", text: "done" }])
		})

		it("should ignore malformed JSON lines without throwing", async () => {
			const handler = setupOpenAi(makeStream(["data: {broken json\n", sse({ choices: [{ delta: { content: "ok" } }] })]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "text", text: "ok" }])
		})

		it("should skip lines that do not start with 'data: '", async () => {
			const handler = setupOpenAi(
				makeStream([": keepalive comment\n", "event: ping\n", sse({ choices: [{ delta: { content: "x" } }] })]),
			)
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "text", text: "x" }])
		})

		it("should yield nothing for an empty stream", async () => {
			const handler = setupOpenAi(makeStream([""]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([])
		})

		it("should handle chunks with no choices and no usage gracefully", async () => {
			const handler = setupOpenAi(makeStream([sse({}), sse({ choices: [] })]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([])
		})

		it("should reassemble a split line across stream chunks", async () => {
			const handler = setupOpenAi(makeStream(['data: {"choices":[{"delta":{"content":"par', 'tial"}}]}\n']))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "text", text: "partial" }])
		})
	})

	describe("createMessage — Anthropic format stream parsing", () => {
		const anthropicModel = {
			id: "claude-sonnet-4",
			supported_endpoints: ["/v1/messages"],
			capabilities: { limits: { max_output_tokens: 8192 } },
		} as any

		function setupAnthropic(body: ReadableStream<Uint8Array>) {
			const handler = new GithubCopilotHandler({ apiModelId: "claude-sonnet-4" } as any)
			stubAuthAndToken()
			sinon.stub(copilotApi, "fetchCopilotModels").resolves([anthropicModel])
			sinon.stub(netModule, "fetch").resolves(makeResponse(body))
			return handler
		}

		it("should route to /v1/messages when the model supports the anthropic endpoint", async () => {
			const handler = setupAnthropic(makeStream([""]))
			for await (const _ of handler.createMessage("sys", [{ role: "user", content: "hi" }])) {
				/* drain */
			}
			sinon.assert.calledWithMatch(netModule.fetch as any, "https://api.githubcopilot.com/v1/messages")
		})

		it("should yield text deltas from content_block_delta", async () => {
			const handler = setupAnthropic(makeStream([sse({ type: "content_block_delta", delta: { text: "hello" } })]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "text", text: "hello" }])
		})

		it("should yield usage from message_delta", async () => {
			const handler = setupAnthropic(
				makeStream([sse({ type: "message_delta", usage: { input_tokens: 50, output_tokens: 7 } })]),
			)
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "usage", inputTokens: 50, outputTokens: 7 }])
		})

		it("should default missing anthropic usage tokens to 0", async () => {
			const handler = setupAnthropic(makeStream([sse({ type: "message_delta", usage: {} })]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([{ type: "usage", inputTokens: 0, outputTokens: 0 }])
		})

		it("should emit a tool_calls chunk on content_block_start (tool_use)", async () => {
			const handler = setupAnthropic(
				makeStream([
					sse({ type: "content_block_start", content_block: { type: "tool_use", id: "tu_1", name: "search" } }),
				]),
			)
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.length.should.equal(1)
			chunks[0].type.should.equal("tool_calls")
			chunks[0].tool_call.call_id.should.equal("tu_1")
			chunks[0].tool_call.function.name.should.equal("search")
			chunks[0].tool_call.function.arguments.should.equal("")
		})

		it("should stream tool argument deltas via input_json_delta", async () => {
			const events = [
				{ type: "content_block_start", content_block: { type: "tool_use", id: "tu_2", name: "run" } },
				{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"a":1' } },
				{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "}" } },
			]
			const handler = setupAnthropic(makeStream([sse(...events)]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			const toolChunks = chunks.filter((c) => c.type === "tool_calls")
			toolChunks.length.should.equal(3) // start + 2 deltas
			toolChunks[1].tool_call.function.arguments.should.equal('{"a":1')
			toolChunks[2].tool_call.function.arguments.should.equal("}")
		})

		it("should ignore input_json_delta when no tool call was started", async () => {
			const handler = setupAnthropic(
				makeStream([sse({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } })]),
			)
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([])
		})

		it("should reset tool call state on content_block_stop", async () => {
			const events = [
				{ type: "content_block_start", content_block: { type: "tool_use", id: "tu_3", name: "x" } },
				{ type: "content_block_stop" },
				{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }, // ignored after stop
			]
			const handler = setupAnthropic(makeStream([sse(...events)]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.length.should.equal(1) // only the start chunk
			chunks[0].tool_call.call_id.should.equal("tu_3")
		})

		it("should handle content_block_delta with no text gracefully", async () => {
			const handler = setupAnthropic(makeStream([sse({ type: "content_block_delta", delta: {} })]))
			const chunks: any[] = []
			for await (const c of handler.createMessage("sys", [{ role: "user", content: "hi" }])) chunks.push(c)
			chunks.should.deepEqual([])
		})
	})
})
