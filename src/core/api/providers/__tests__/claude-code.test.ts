import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import { ClaudeCodeHandler } from "@core/api/providers/claude-code"
import { expect } from "chai"
import { DiracStorageMessage } from "@/shared/messages/content"

describe("ClaudeCodeHandler", () => {
	let handler: ClaudeCodeHandler
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		handler = new ClaudeCodeHandler({
			claudeCodePath: "/mock/path",
			apiModelId: "claude-opus-4-1-20250805",
		})
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("token counting", () => {
		it("should correctly handle token usage from assistant messages", async () => {
			// The 'input_tokens' field represents the TOTAL number of input tokens used.
			// See https://docs.anthropic.com/en/api/messages#usage-object

			// Mock the runClaudeCode function
			const runClaudeCodeModule = await import("@/integrations/claude-code/run")
			const runClaudeCodeStub = sandbox.stub(runClaudeCodeModule, "runClaudeCode")

			// Create a proper async generator mock for the Claude Code response
			async function* mockGenerator() {
				// First yield the system init
				yield {
					type: "system",
					subtype: "init",
					apiKeySource: "api",
				}

				// Yield assistant message with usage data
				// Example: If base input is 70 tokens, cache read is 20, and cache creation is 10,
				// then input_tokens from Anthropic API will be 100 (70 + 20 + 10)
				yield {
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: "Test response",
							},
						],
						usage: {
							input_tokens: 100, // Total including cache (per Anthropic docs)
							output_tokens: 50,
							cache_read_input_tokens: 20, // Already included in input_tokens
							cache_creation_input_tokens: 10, // Already included in input_tokens
						},
						stop_reason: "end_turn",
					},
				}

				// Yield result with cost
				yield {
					type: "result",
					result: {},
					total_cost_usd: 0.005,
				}
			}

			runClaudeCodeStub.returns(mockGenerator() as any)

			const systemPrompt = "You are a helpful assistant."
			const messages: DiracStorageMessage[] = [{ role: "user", content: "Hello" }]

			const usageData: any[] = []

			// Collect the results
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				if (chunk.type === "usage") {
					usageData.push({
						inputTokens: chunk.inputTokens,
						outputTokens: chunk.outputTokens,
						cacheReadTokens: chunk.cacheReadTokens,
						cacheWriteTokens: chunk.cacheWriteTokens,
						totalCost: chunk.totalCost,
					})
				}
			}

			// Verify token counting follows Anthropic API specification
			usageData.should.have.length(1)
			usageData[0].should.deepEqual({
				inputTokens: 100, // Total including cache tokens (per Anthropic API docs)
				outputTokens: 50,
				cacheReadTokens: 20, // Tracked separately for reporting
				cacheWriteTokens: 10, // Tracked separately for reporting
				totalCost: 0.005,
			})

			// CRITICAL ASSERTION: Verify that input_tokens is NOT inflated by re-adding cache tokens
			// The bug would have caused inputTokens to be incorrectly calculated as 130 (100 + 20 + 10)
			// The fix ensures it remains 100, as per Anthropic's specification
			usageData[0].inputTokens.should.equal(100) // Correct: matches API response
			usageData[0].inputTokens.should.not.equal(130) // Would be wrong: double-counting cache tokens
		})

		it("should handle missing usage fields with nullish coalescing", async () => {
			// Mock the runClaudeCode function
			const runClaudeCodeModule = await import("@/integrations/claude-code/run")
			const runClaudeCodeStub = sandbox.stub(runClaudeCodeModule, "runClaudeCode")

			// Create a proper async generator mock with missing/undefined usage fields
			async function* mockGenerator() {
				yield {
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: "Test response",
							},
						],
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							// cache fields are undefined/missing
						},
						stop_reason: "end_turn",
					},
				}

				yield {
					type: "result",
					result: {},
					total_cost_usd: 0.005,
				}
			}

			runClaudeCodeStub.returns(mockGenerator() as any)

			const systemPrompt = "You are a helpful assistant."
			const messages: DiracStorageMessage[] = [{ role: "user", content: "Hello" }]

			const usageData: any[] = []

			// Collect the results
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				if (chunk.type === "usage") {
					usageData.push({
						inputTokens: chunk.inputTokens,
						outputTokens: chunk.outputTokens,
						cacheReadTokens: chunk.cacheReadTokens,
						cacheWriteTokens: chunk.cacheWriteTokens,
					})
				}
			}

			// Verify that undefined cache tokens default to 0
			usageData.should.have.length(1)
			usageData[0].should.deepEqual({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0, // Should default to 0
				cacheWriteTokens: 0, // Should default to 0
			})
		})

		it("should handle completely missing usage object", async () => {
			// Mock the runClaudeCode function
			const runClaudeCodeModule = await import("@/integrations/claude-code/run")
			const runClaudeCodeStub = sandbox.stub(runClaudeCodeModule, "runClaudeCode")

			// Create a proper async generator mock with missing usage object
			async function* mockGenerator() {
				yield {
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: "Test response",
							},
						],
						// usage is undefined
						usage: undefined,
						stop_reason: "end_turn",
					},
				}

				// Need to yield a result chunk to trigger usage data emission
				yield {
					type: "result",
					result: {},
					total_cost_usd: 0,
				}
			}

			runClaudeCodeStub.returns(mockGenerator() as any)

			const systemPrompt = "You are a helpful assistant."
			const messages: DiracStorageMessage[] = [{ role: "user", content: "Hello" }]

			const usageData: any[] = []

			// Collect the results
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				if (chunk.type === "usage") {
					usageData.push({
						inputTokens: chunk.inputTokens,
						outputTokens: chunk.outputTokens,
						cacheReadTokens: chunk.cacheReadTokens,
						cacheWriteTokens: chunk.cacheWriteTokens,
					})
				}
			}

			// All token counts should default to 0 when usage is undefined
			usageData.should.have.length(1)
			usageData[0].should.deepEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			})
		})
	})

	describe("structured output tool calls", () => {
		async function collectToolCalls(toolUseContent: any) {
			const runClaudeCodeModule = await import("@/integrations/claude-code/run")
			const runClaudeCodeStub = sandbox.stub(runClaudeCodeModule, "runClaudeCode")

			async function* mockGenerator() {
				yield { type: "system", subtype: "init", apiKeySource: "none" }
				yield {
					type: "assistant",
					message: {
						content: [toolUseContent],
						usage: { input_tokens: 10, output_tokens: 5 },
						stop_reason: "end_turn",
					},
				}
				// The CLI echoes a tool_result for the StructuredOutput call; it must be ignored.
				yield {
					type: "user",
					message: {
						content: [
							{ type: "tool_result", tool_use_id: "toolu_1", content: "Structured output provided successfully" },
						],
					},
				}
				// Capping at one turn ends the run with an error_max_turns result (no `result` field),
				// which still carries final cost and must be processed for usage.
				yield { type: "result", subtype: "error_max_turns", is_error: true, total_cost_usd: 0 }
			}

			runClaudeCodeStub.returns(mockGenerator() as any)

			const messages: DiracStorageMessage[] = [{ role: "user", content: "Hi" }]
			const toolCalls: any[] = []
			for await (const chunk of handler.createMessage("sys", messages)) {
				if (chunk.type === "tool_calls") {
					toolCalls.push(chunk.tool_call)
				}
			}
			return toolCalls
		}

		it("unwraps the StructuredOutput array form into native tool_calls", async () => {
			const toolCalls = await collectToolCalls({
				type: "tool_use",
				id: "toolu_1",
				name: "StructuredOutput",
				input: {
					tool_calls: [
						{ tool: "read_file", params: { path: "a.ts" } },
						{ tool: "execute_command", params: { command: "ls" } },
					],
				},
			})

			toolCalls.should.have.length(2)
			toolCalls[0].function.name.should.equal("read_file")
			JSON.parse(toolCalls[0].function.arguments).should.deepEqual({ path: "a.ts" })
			toolCalls[1].function.name.should.equal("execute_command")
			JSON.parse(toolCalls[1].function.arguments).should.deepEqual({ command: "ls" })
			// Must not surface the raw StructuredOutput wrapper.
			toolCalls.some((c) => c.function.name === "StructuredOutput").should.equal(false)
		})

		it("unwraps the StructuredOutput single-object form", async () => {
			const toolCalls = await collectToolCalls({
				type: "tool_use",
				id: "toolu_1",
				name: "StructuredOutput",
				input: { tool: "attempt_completion", params: { result: "done" } },
			})

			toolCalls.should.have.length(1)
			toolCalls[0].function.name.should.equal("attempt_completion")
			JSON.parse(toolCalls[0].function.arguments).should.deepEqual({ result: "done" })
		})
	})

	describe("getModel", () => {
		it("should return the correct model when specified", () => {
			const handler = new ClaudeCodeHandler({
				apiModelId: "claude-sonnet-4-6",
			})

			const model = handler.getModel()
			model.id.should.equal("claude-sonnet-4-6")
		})

		it("should support Opus 4.6 1m model id", () => {
			const handler = new ClaudeCodeHandler({
				apiModelId: "claude-opus-4-6[1m]",
			})

			const model = handler.getModel()
			model.id.should.equal("claude-opus-4-6[1m]")
			model.info.contextWindow!.should.equal(1_000_000)
		})

		it("should support Opus 1m alias model id", () => {
			const handler = new ClaudeCodeHandler({
				apiModelId: "opus[1m]",
			})

			const model = handler.getModel()
			model.id.should.equal("opus[1m]")
			model.info.contextWindow!.should.equal(1_000_000)
		})

		it("should support Sonnet 1m alias model id", () => {
			const handler = new ClaudeCodeHandler({
				apiModelId: "claude-sonnet-4-6[1m]",
			})

			const model = handler.getModel()
			model.id.should.equal("claude-sonnet-4-6[1m]")
			model.info.contextWindow!.should.equal(1_000_000)
		})

		it("should support Sonnet 4.5 1m model id", () => {
			const handler = new ClaudeCodeHandler({
				apiModelId: "claude-sonnet-4-6[1m]",
			})

			const model = handler.getModel()
			model.id.should.equal("claude-sonnet-4-6[1m]")
			model.info.contextWindow!.should.equal(1_000_000)
		})

		it("should support Sonnet 4.6 1m model id", () => {
			const handler = new ClaudeCodeHandler({
				apiModelId: "claude-sonnet-4-6[1m]",
			})

			const model = handler.getModel()
			model.id.should.equal("claude-sonnet-4-6[1m]")
			model.info.contextWindow!.should.equal(1_000_000)
		})

		it("should return default model when not specified", () => {
			const handler = new ClaudeCodeHandler({})

			const model = handler.getModel()
			// The default model should be set
			model.id.should.be.type("string")
			model.info.should.be.type("object")
		})
	})

	// Characterization tests for ClaudeCodeHandler.createMessage stream parsing.
	// Covers string chunks, assistant content types (text/thinking/redacted_thinking/tool_use),
	// system init (paid vs subscription usage), result cost, and edge cases.
	describe("stream parsing", () => {
		afterEach(() => sinon.restore())

		// Helper: stub runClaudeCode to yield the given chunks as an async generator.
		const stubRun = async (chunks: any[]) => {
			const mod = await import("@/integrations/claude-code/run")
			const gen = async function* () {
				yield* chunks
			}
			sinon.stub(mod, "runClaudeCode").returns(gen() as any)
		}

		it("yields string chunks as text", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun(["Hello", " world"])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.deepEqual([
				{ type: "text", text: "Hello" },
				{ type: "text", text: " world" },
			])
		})

		it("yields thinking content as reasoning", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{ type: "assistant", message: { content: [{ type: "thinking", thinking: "my thoughts" }], stop_reason: null } },
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.deepEqual([{ type: "reasoning", reasoning: "my thoughts" }])
		})

		it("yields redacted_thinking as a placeholder reasoning block", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([{ type: "assistant", message: { content: [{ type: "redacted_thinking" }], stop_reason: null } }])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.deepEqual([{ type: "reasoning", reasoning: "[Redacted thinking block]" }])
		})

		it("yields empty string reasoning when thinking content is empty", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([{ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }], stop_reason: null } }])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.deepEqual([{ type: "reasoning", reasoning: "" }])
		})

		it("yields tool_use blocks as tool_calls with JSON-stringified input", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{
					type: "assistant",
					message: {
						content: [{ type: "tool_use", id: "tool_1", name: "get_weather", input: { city: "SF" } }],
						stop_reason: null,
					},
				},
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.have.length(1)
			chunks[0].type.should.equal("tool_calls")
			chunks[0].tool_call.call_id.should.equal("tool_1")
			chunks[0].tool_call.function.id.should.equal("tool_1")
			chunks[0].tool_call.function.name.should.equal("get_weather")
			chunks[0].tool_call.function.arguments.should.equal('{"city":"SF"}')
		})

		it("yields mixed content types from a single assistant message", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{
					type: "assistant",
					message: {
						content: [
							{ type: "thinking", thinking: "reasoning here" },
							{ type: "text", text: "answer" },
							{ type: "tool_use", id: "t1", name: "foo", input: { x: 1 } },
						],
						stop_reason: null,
					},
				},
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.deepEqual([
				{ type: "reasoning", reasoning: "reasoning here" },
				{ type: "text", text: "answer" },
				{ type: "tool_calls", tool_call: { call_id: "t1", function: { id: "t1", name: "foo", arguments: '{"x":1}' } } },
			])
		})

		it("sets totalCost to 0 for subscription usage (apiKeySource none)", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{ type: "system", subtype: "init", apiKeySource: "none" },
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "hi" }],
						usage: { input_tokens: 10, output_tokens: 5 },
						stop_reason: "end_turn",
					},
				},
				{ type: "result", result: {}, total_cost_usd: 0.003 },
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			const usage = chunks.find((c) => c.type === "usage")
			usage.should.deepEqual({
				type: "usage",
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCost: 0,
			})
		})

		it("sets totalCost from result chunk for paid usage (apiKeySource api)", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{ type: "system", subtype: "init", apiKeySource: "api" },
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "hi" }],
						usage: { input_tokens: 10, output_tokens: 5 },
						stop_reason: "end_turn",
					},
				},
				{ type: "result", result: {}, total_cost_usd: 0.003 },
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			const usage = chunks.find((c) => c.type === "usage")
			usage.totalCost.should.equal(0.003)
		})

		it("defaults isPaidUsage to true when no system init chunk is sent", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "hi" }],
						usage: { input_tokens: 1, output_tokens: 1 },
						stop_reason: "end_turn",
					},
				},
				{ type: "result", result: {}, total_cost_usd: 0.01 },
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			const usage = chunks.find((c) => c.type === "usage")
			// No init chunk -> isPaidUsage stays true -> cost included
			usage.totalCost.should.equal(0.01)
		})

		it("yields nothing for an empty stream", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.deepEqual([])
		})

		it("does not yield usage if no result chunk is sent", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "hi" }],
						usage: { input_tokens: 1, output_tokens: 1 },
						stop_reason: "end_turn",
					},
				},
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			// Only text, no usage (usage is only emitted on result chunk)
			chunks.should.deepEqual([{ type: "text", text: "hi" }])
		})
	})

	// Characterization tests for ClaudeCodeHandler.createMessage error handling.
	// API Error messages in assistant content are parsed and re-thrown with context.
	describe("error handling", () => {
		afterEach(() => sinon.restore())

		const stubRun = async (chunks: any[]) => {
			const mod = await import("@/integrations/claude-code/run")
			const gen = async function* () {
				yield* chunks
			}
			sinon.stub(mod, "runClaudeCode").returns(gen() as any)
		}

		it("throws the full text when API Error JSON cannot be parsed", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{
					type: "assistant",
					message: { content: [{ type: "text", text: "API Error: 500 not json" }], stop_reason: "error" },
				},
			])
			try {
				for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
					/* drain */
				}
				throw new Error("expected throw")
			} catch (e) {
				;(e as Error).message.should.equal("API Error: 500 not json")
			}
		})

		it("throws parsed error message for generic API errors", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			const errorJson = JSON.stringify({ error: { message: "overloaded", type: "overloaded_error" } })
			await stubRun([
				{
					type: "assistant",
					message: { content: [{ type: "text", text: `API Error: 529 ${errorJson}` }], stop_reason: "error" },
				},
			])
			try {
				for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
					/* drain */
				}
				throw new Error("expected throw")
			} catch (e) {
				;(e as Error).message.should.equal(errorJson)
			}
		})

		it("adds a plan hint for Invalid model name errors", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			const errorJson = JSON.stringify({ error: { message: "Invalid model name: foo", type: "invalid_request_error" } })
			const fullText = `API Error: 400 ${errorJson}`
			await stubRun([{ type: "assistant", message: { content: [{ type: "text", text: fullText }], stop_reason: "error" } }])
			try {
				for await (const _ of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
					/* drain */
				}
				throw new Error("expected throw")
			} catch (e) {
				// The thrown message includes the full text plus the plan hint
				expect((e as Error).message).to.include("API Error: 400")
				expect((e as Error).message).to.include("API keys and subscription plans allow different models")
			}
		})

		it("does not treat non-API-Error text as an error even with stop_reason", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			await stubRun([
				{ type: "assistant", message: { content: [{ type: "text", text: "Normal response" }], stop_reason: "end_turn" } },
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			chunks.should.deepEqual([{ type: "text", text: "Normal response" }])
		})

		it("ignores assistant messages with null stop_reason for error detection", async () => {
			const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-4-6" })
			// stop_reason is null -> error detection branch is skipped
			await stubRun([
				{ type: "assistant", message: { content: [{ type: "text", text: "API Error: 500 {bad}" }], stop_reason: null } },
			])
			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
			// Content is yielded as normal text since stop_reason is null
			chunks.should.deepEqual([{ type: "text", text: "API Error: 500 {bad}" }])
		})
	})
})
