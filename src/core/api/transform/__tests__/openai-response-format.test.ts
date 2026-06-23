import "should"
import { expect } from "chai"
import { convertToOpenAIResponsesInput } from "../openai-response-format"

// Characterization tests for convertToOpenAIResponsesInput.
// Converts DiracStorageMessage[] to OpenAI Responses API input array,
// maintaining reasoning-message pairing and tool call/output mapping.
describe("convertToOpenAIResponsesInput", () => {
	describe("string content", () => {
		it("wraps string user content as input_text message", () => {
			const result = convertToOpenAIResponsesInput([{ role: "user", content: "hello" }] as any)
			result.input.should.have.length(1)
			result.input[0].should.deepEqual({ role: "user", content: [{ type: "input_text", text: "hello" }] })
		})

		it("wraps string assistant content as input_text message", () => {
			const result = convertToOpenAIResponsesInput([{ role: "assistant", content: "hi" }] as any)
			result.input[0].should.deepEqual({ role: "assistant", content: [{ type: "input_text", text: "hi" }] })
		})
	})

	describe("user array content", () => {
		it("converts text blocks to input_text", () => {
			const result = convertToOpenAIResponsesInput([{ role: "user", content: [{ type: "text", text: "a" }] }] as any)
			result.input[0].should.deepEqual({ role: "user", content: [{ type: "input_text", text: "a" }] })
		})

		it("defaults empty text to empty string", () => {
			const result = convertToOpenAIResponsesInput([{ role: "user", content: [{ type: "text" }] }] as any)
			;(result.input[0] as any).content[0].text.should.equal("")
		})

		it("converts base64 image to input_image with data url", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] },
			] as any)
			const content = (result.input[0] as any).content[0]
			content.type.should.equal("input_image")
			content.detail.should.equal("auto")
			content.image_url.should.equal("data:image/png;base64,abc")
		})

		it("converts url image to input_image with url", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x.com/i.png" } as any }] },
			] as any)
			;(result.input[0] as any).content[0].image_url.should.equal("https://x.com/i.png")
		})

		it("converts tool_result with string content to function_call_output", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
			] as any)
			result.input[0].should.deepEqual({ type: "function_call_output", call_id: "t1", output: "result" })
		})

		it("converts tool_result with array content to JSON string output", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x" }] }] },
			] as any)
			const output = (result.input[0] as any).output
			output.should.be.a.String()
			expect(output).to.include("text")
		})

		it("flushes pending text content before tool_result", () => {
			const result = convertToOpenAIResponsesInput([
				{
					role: "user",
					content: [
						{ type: "text", text: "before" },
						{ type: "tool_result", tool_use_id: "t1", content: "r" },
					],
				},
			] as any)
			result.input.should.have.length(2)
			result.input[0].should.deepEqual({ role: "user", content: [{ type: "input_text", text: "before" }] })
			result.input[1].should.deepEqual({ type: "function_call_output", call_id: "t1", output: "r" })
		})

		it("flushes remaining user content after tool_result", () => {
			const result = convertToOpenAIResponsesInput([
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "r" },
						{ type: "text", text: "after" },
					],
				},
			] as any)
			result.input.should.have.length(2)
			result.input[1].should.deepEqual({ role: "user", content: [{ type: "input_text", text: "after" }] })
		})

		it("uses call_id from tool_result when present", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", call_id: "call_x", content: "r" }] },
			] as any)
			;(result.input[0] as any).call_id.should.equal("call_x")
		})

		it("resolves call_id from prior assistant tool_use mapping", () => {
			const result = convertToOpenAIResponsesInput([
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_1", call_id: "call_99", name: "fn", input: {} }],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "r" }] },
			] as any)
			const outputItem = result.input.find((i: any) => i.type === "function_call_output")!
			;(outputItem as any).call_id.should.equal("call_99")
		})

		it("falls back to tool_use_id when no call_id mapping exists", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
			] as any)
			;(result.input[0] as any).call_id.should.equal("t1")
		})
	})

	describe("assistant array content", () => {
		it("converts text block to assistant message with output_text", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "text", text: "ans", call_id: "c1" }] },
			] as any)
			result.input[0].should.deepEqual({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "ans" }],
			})
		})

		it("defaults empty text to empty string", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "text", call_id: "c1" }] },
			] as any)
			;(result.input[0] as any).content[0].text.should.equal("")
		})

		it("converts thinking block with thinking content to reasoning summary_text", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "s", call_id: "c1" }] },
			] as any)
			result.input[0].should.deepEqual({ type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] })
		})

		it("uses summary array when present on thinking block", () => {
			const summary = [{ type: "summary_text", text: "precomputed" }]
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "thinking", thinking: "ignored", summary, call_id: "c1" }] },
			] as any)
			;(result.input[0] as any).summary.should.equal(summary)
		})

		it("creates reasoning with empty summary when thinking content is whitespace only", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "thinking", thinking: "   ", signature: "s", call_id: "c1" }] },
			] as any)
			;(result.input[0] as any).summary.should.deepEqual([])
		})

		it("converts redacted_thinking to reasoning with encrypted_content", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "redacted_thinking", data: "encrypted", call_id: "c1" }] },
			] as any)
			;(result.input[0] as any).type.should.equal("reasoning")
			;(result.input[0] as any).encrypted_content.should.equal("encrypted")
		})

		it("creates reasoning with empty summary when redacted_thinking has no data", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "redacted_thinking", call_id: "c1" }] },
			] as any)
			;(result.input[0] as any).summary.should.deepEqual([])
			should.equal((result.input[0] as any).encrypted_content, undefined)
		})

		it("converts tool_use to function_call with JSON arguments", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "tool_use", id: "c1", call_id: "call_1", name: "fn", input: { x: 1 } }] },
			] as any)
			result.input[0].should.deepEqual({
				type: "function_call",
				call_id: "call_1",
				name: "fn",
				arguments: '{"x":1}',
			})
		})

		it("defaults tool_use input to empty object when undefined", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "fn" }] },
			] as any)
			;(result.input[0] as any).arguments.should.equal("{}")
		})

		it("uses id as call_id when call_id absent on tool_use", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "tool_use", id: "toolu_5", name: "fn", input: {} }] },
			] as any)
			;(result.input[0] as any).call_id.should.equal("toolu_5")
		})

		it("skips assistant parts without call_id or id", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "text", text: "no-id" }] },
			] as any)
			result.input.should.have.length(0)
		})

		it("converts assistant image block to output_text placeholder", () => {
			const result = convertToOpenAIResponsesInput([
				{
					role: "assistant",
					content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "d" }, call_id: "c1" }],
				},
			] as any)
			;(result.input[0] as any).content[0].text.should.equal("[image:image/png]")
		})
	})

	describe("reasoning pairing", () => {
		it("inserts placeholder message when reasoning is last item in turn", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "assistant", content: [{ type: "thinking", thinking: "orphan", signature: "s", call_id: "c1" }] },
			] as any)
			result.input.should.have.length(2)
			result.input[0].should.deepEqual({ type: "reasoning", summary: [{ type: "summary_text", text: "orphan" }] })
			result.input[1].should.deepEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] })
		})

		it("inserts placeholder message when two reasoning items are consecutive", () => {
			const result = convertToOpenAIResponsesInput([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "r1", signature: "s", call_id: "c1" },
						{ type: "thinking", thinking: "r2", signature: "s", call_id: "c2" },
					],
				},
			] as any)
			// r1 followed by placeholder, then r2 followed by placeholder
			const types = result.input.map((i: any) => i.type)
			expect(types).to.deep.equal(["reasoning", "message", "reasoning", "message"])
		})

		it("does not insert placeholder when reasoning is followed by a message", () => {
			const result = convertToOpenAIResponsesInput([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "r1", signature: "s", call_id: "c1" },
						{ type: "text", text: "ans", call_id: "c2" },
					],
				},
			] as any)
			const types = result.input.map((i: any) => i.type)
			expect(types).to.deep.equal(["reasoning", "message"])
		})

		it("does not insert placeholder when reasoning is followed by a function_call", () => {
			const result = convertToOpenAIResponsesInput([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "r1", signature: "s", call_id: "rs_aaa" },
						{ type: "tool_use", id: "rs_bbb", call_id: "rs_bbb", name: "fn", input: {} },
					],
				},
			] as any)
			const types = result.input.map((i: any) => i.type)
			expect(types).to.deep.equal(["reasoning", "function_call"])
		})

		it("sorts items by raw hex id to restore generation sequence", () => {
			// c2 has a "larger" hex suffix than c1; ensure reasoning c1 comes before message c2
			const result = convertToOpenAIResponsesInput([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "ans", call_id: "rs_bbb" },
						{ type: "thinking", thinking: "r1", signature: "s", call_id: "rs_aaa" },
					],
				},
			] as any)
			result.input[0].should.deepEqual({ type: "reasoning", summary: [{ type: "summary_text", text: "r1" }] })
			result.input[1].should.deepEqual({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "ans" }],
			})
		})
	})

	describe("previousResponseId chaining", () => {
		it("returns previousResponseId undefined when option not set", () => {
			const result = convertToOpenAIResponsesInput([{ role: "assistant", content: "hi", id: "resp_1" }] as any)
			should.equal(result.previousResponseId, undefined)
		})

		it("chains from latest assistant message with id when usePreviousResponseId=true", () => {
			const result = convertToOpenAIResponsesInput(
				[
					{ role: "user", content: "u" },
					{ role: "assistant", content: "a", id: "resp_123", ts: Date.now() } as any,
					{ role: "user", content: "new" },
				] as any,
				{ usePreviousResponseId: true },
			)
			expect(result.previousResponseId).to.equal("resp_123")
			// only the message after the assistant turn is sent
			result.input.should.have.length(1)
			;(result.input[0] as any).content[0].text.should.equal("new")
		})

		it("does not chain when assistant message is older than 23 hours", () => {
			const oldTs = Date.now() - 24 * 60 * 60 * 1000
			const result = convertToOpenAIResponsesInput(
				[{ role: "assistant", content: "a", id: "resp_old", ts: oldTs } as any, { role: "user", content: "new" }] as any,
				{ usePreviousResponseId: true },
			)
			should.equal(result.previousResponseId, undefined)
			result.input.should.have.length(2)
		})

		it("does not chain when assistant message has no id", () => {
			const result = convertToOpenAIResponsesInput(
				[{ role: "assistant", content: "a", ts: Date.now() } as any, { role: "user", content: "new" }] as any,
				{ usePreviousResponseId: true },
			)
			should.equal(result.previousResponseId, undefined)
			result.input.should.have.length(2)
		})

		it("breaks after first assistant message even if it has no usable id", () => {
			const result = convertToOpenAIResponsesInput(
				[
					{ role: "assistant", content: "a1", id: "resp_earlier", ts: Date.now() } as any,
					{ role: "assistant", content: "a2", id: "resp_latest", ts: Date.now() } as any,
					{ role: "user", content: "new" },
				] as any,
				{ usePreviousResponseId: true },
			)
			// chains from the latest assistant message (first found in reverse iteration)
			expect(result.previousResponseId).to.equal("resp_latest")
		})

		it("handles empty messages array with chaining option", () => {
			const result = convertToOpenAIResponsesInput([], { usePreviousResponseId: true })
			result.input.should.deepEqual([])
			should.equal(result.previousResponseId, undefined)
		})
	})

	describe("mixed scenarios", () => {
		it("processes a full conversation with tool use and results", () => {
			const result = convertToOpenAIResponsesInput([
				{ role: "user", content: "question" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", signature: "s", call_id: "rs_1" },
						{ type: "text", text: "let me check", call_id: "rs_2" },
						{ type: "tool_use", id: "toolu_1", call_id: "call_1", name: "fn", input: { q: "x" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "answer" }] },
			] as any)
			const types = result.input.map((i: any) => i.type || i.role)
			// user message, then assistant turn sorted by raw hex: rs_1(reasoning), call_1(function_call), rs_2(message), then function_call_output
			expect(types).to.deep.equal(["user", "reasoning", "function_call", "message", "function_call_output"])
		})

		it("handles empty content array on user message", () => {
			const result = convertToOpenAIResponsesInput([{ role: "user", content: [] }] as any)
			result.input.should.have.length(0)
		})

		it("handles empty content array on assistant message", () => {
			const result = convertToOpenAIResponsesInput([{ role: "assistant", content: [] }] as any)
			result.input.should.have.length(0)
		})
	})
})
