import "should"
import { expect } from "chai"
import { StreamResponseHandler } from "../StreamResponseHandler"

// Characterization tests for StreamResponseHandler — verifies streaming
// chunk parsing for text, tool use, and reasoning blocks, including
// ordering, completion, and partial JSON recovery.
describe("StreamResponseHandler", () => {
	let handler: StreamResponseHandler

	beforeEach(() => { handler = new StreamResponseHandler() })

	describe("text deltas", () => {
		it("accumulates text across multiple deltas with same id", () => {
			handler.processTextDelta({ id: "t1", text: "Hello " })
			handler.processTextDelta({ id: "t1", text: "World" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(1)
			const b = blocks[0] as any
			b.type.should.equal("text")
			b.text.should.equal("Hello World")
			expect(b.signature).to.be.undefined
			b.call_id.should.equal("t1")
		})

		it("generates a nanoid when id is missing", () => {
			handler.processTextDelta({ text: "no id" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(1)
			const b = blocks[0] as any
			b.type.should.equal("text")
			b.text.should.equal("no id")
			b.call_id.should.startWith("text_")
		})

		it("reuses lastActiveId for text when id is missing", () => {
			handler.processTextDelta({ id: "t1", text: "first" })
			handler.processTextDelta({ text: " second" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(1)
			;(blocks[0] as any).text.should.equal("first second")
		})

		it("preserves signature across deltas", () => {
			handler.processTextDelta({ id: "t1", text: "signed", signature: "sig123" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).signature.should.equal("sig123")
		})

		it("ignores empty text deltas but still records id", () => {
			handler.processTextDelta({ id: "t1" })
			handler.processTextDelta({ id: "t1", text: "data" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).text.should.equal("data")
		})

		it("maintains block ordering across multiple text blocks", () => {
			handler.processTextDelta({ id: "t1", text: "A" })
			handler.processTextDelta({ id: "t2", text: "B" })
			handler.processTextDelta({ id: "t1", text: " continued" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(2)
			;(blocks[0] as any).text.should.equal("A continued")
			;(blocks[1] as any).text.should.equal("B")
		})
	})

	describe("tool use deltas", () => {
		it("accumulates tool use input across deltas", () => {
			handler.processToolUseDelta({ id: "tu1", name: "read_file" })
			handler.processToolUseDelta({ id: "tu1", input: '{"path":' })
			handler.processToolUseDelta({ id: "tu1", input: '"/test"}' })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(1)
			const b = blocks[0] as any
			b.type.should.equal("tool_use")
			b.name.should.equal("read_file")
			b.input.should.deepEqual({ path: "/test" })
		})

		it("defaults id to 'default_tool_use' when missing", () => {
			handler.processToolUseDelta({ name: "test_tool", input: "{}" })
			const blocks = handler.getOrderedBlocks()
			const b = blocks[0] as any
			b.type.should.equal("tool_use")
			b.call_id.should.equal("default_tool_use")
		})

		it("uses provided call_id", () => {
			handler.processToolUseDelta({ id: "tu1", name: "test" }, "custom_call_id")
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).call_id.should.equal("custom_call_id")
		})

		it("extracts partial JSON fields when input is incomplete", () => {
			handler.processToolUseDelta({ id: "tu1", name: "write_file" })
			handler.processToolUseDelta({ id: "tu1", input: '{"path": "/test", "content": "hello' })
			const blocks = handler.getOrderedBlocks()
			const b = blocks[0] as any
			b.type.should.equal("tool_use")
			b.input.path.should.equal("/test")
			b.input.content.should.equal("hello")
		})

		it("extracts array values from partial JSON", () => {
			handler.processToolUseDelta({ id: "tu1", name: "test" })
			handler.processToolUseDelta({ id: "tu1", input: '{"items": ["a", "b", "c"]' })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).input.items.should.deepEqual(["a", "b", "c"])
		})

		it("handles escape sequences in partial JSON strings", () => {
			handler.processToolUseDelta({ id: "tu1", name: "test" })
			handler.processToolUseDelta({ id: "tu1", input: '{"text": "hello\\nworld"' })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).input.text.should.equal("hello\nworld")
		})

		it("marks previous tool use as complete when new id arrives", () => {
			handler.processToolUseDelta({ id: "tu1", name: "tool1", input: "{}" })
			handler.processToolUseDelta({ id: "tu2", name: "tool2", input: "{}" })
			const states = handler.getParsedToolUseStates()
			const s1 = states.find((s) => s.id === "tu1")
			s1?.isComplete.should.equal(true)
		})

		it("preserves signature on tool use", () => {
			handler.processToolUseDelta({ id: "tu1", name: "test", signature: "sig" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).signature.should.equal("sig")
		})

		it("returns empty array from getOrderedBlocks for tool use with no name", () => {
			handler.processToolUseDelta({ id: "tu1" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(0)
		})

		it("getParsedToolUseStates returns all named tool uses", () => {
			handler.processToolUseDelta({ id: "tu1", name: "tool1", input: '{"a":1}' })
			handler.processToolUseDelta({ id: "tu2", name: "tool2", input: '{"b":2}' })
			const states = handler.getParsedToolUseStates()
			states.should.have.length(2)
			states.map((s) => s.name).should.containEql("tool1")
			states.map((s) => s.name).should.containEql("tool2")
		})

		it("getParsedToolUseStates forces isComplete when passed true", () => {
			handler.processToolUseDelta({ id: "tu1", name: "tool1", input: "{}" })
			const states = handler.getParsedToolUseStates(true)
			states[0].isComplete.should.equal(true)
		})
	})

	describe("reasoning deltas", () => {
		it("accumulates reasoning content across deltas", () => {
			handler.processReasoningDelta({ id: "r1", reasoning: "Thinking " })
			handler.processReasoningDelta({ id: "r1", reasoning: "hard" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(1)
			const b = blocks[0] as any
			b.type.should.equal("thinking")
			b.thinking.should.equal("Thinking hard")
		})

		it("accumulates reasoning details/summary", () => {
			handler.processReasoningDelta({ id: "r1", reasoning: "test", details: [{ type: "summary", text: "s1" }] as any })
			handler.processReasoningDelta({ id: "r1", details: [{ type: "summary", text: "s2" }] })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).summary.should.have.length(2)
		})

		it("captures redacted thinking blocks", () => {
			handler.processReasoningDelta({ id: "r1", reasoning: "test", redacted_data: "redacted1" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).type.should.equal("redacted_thinking")
			;(blocks[1] as any).type.should.equal("thinking")
		})

		it("preserves signature on reasoning", () => {
			handler.processReasoningDelta({ id: "r1", reasoning: "test", signature: "sig" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).signature.should.equal("sig")
		})

		it("extracts signature from last summary entry if missing", () => {
			handler.processReasoningDelta({ id: "r1", reasoning: "test", details: [{ signature: "from_summary" }] as any })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).signature.should.equal("from_summary")
		})

		it("returns null thinking block when only redacted data exists", () => {
			handler.processReasoningDelta({ id: "r1", redacted_data: "redacted1" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(1)
			;(blocks[0] as any).type.should.equal("redacted_thinking")
		})

		it("defaults id to 'default_reasoning' when missing", () => {
			handler.processReasoningDelta({ reasoning: "no id" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).call_id.should.equal("default_reasoning")
		})

		it("marks previous reasoning as complete when new id arrives", () => {
			handler.processReasoningDelta({ id: "r1", reasoning: "first" })
			handler.processReasoningDelta({ id: "r2", reasoning: "second" })
			const { reasonsHandler } = handler.getHandlers()
			const block = reasonsHandler.getReasoningBlock("r1") as any
			block?.isComplete.should.equal(true)
		})
	})

	describe("block ordering", () => {
		it("preserves insertion order across text, tool use, and reasoning", () => {
			handler.processTextDelta({ id: "t1", text: "text" })
			handler.processToolUseDelta({ id: "tu1", name: "tool", input: "{}" })
			handler.processReasoningDelta({ id: "r1", reasoning: "reason" })
			handler.processTextDelta({ id: "t2", text: "more" })
			const blocks = handler.getOrderedBlocks()
			blocks.map((b) => (b as any).type).should.deepEqual(["text", "tool_use", "thinking", "text"])
		})

		it("does not duplicate blocks when same id is reused", () => {
			handler.processTextDelta({ id: "t1", text: "a" })
			handler.processTextDelta({ id: "t1", text: "b" })
			handler.getOrderedBlocks().should.have.length(1)
		})
	})

	describe("requestId", () => {
		it("setRequestId stores id only once", () => {
			handler.setRequestId("req1")
			handler.setRequestId("req2")
			handler.requestId!.should.equal("req1")
		})

		it("setRequestId ignores undefined", () => {
			handler.setRequestId("req1")
			handler.setRequestId(undefined)
			handler.requestId!.should.equal("req1")
		})

		it("requestId is undefined initially", () => {
			expect(handler.requestId).to.be.undefined
		})
	})

	describe("reset", () => {
		it("clears all state", () => {
			handler.processTextDelta({ id: "t1", text: "data" })
			handler.setRequestId("req1")
			handler.reset()
			handler.getOrderedBlocks().should.have.length(0)
			expect(handler.requestId).to.be.undefined
		})
	})

	describe("edge cases", () => {
		it("handles empty input gracefully", () => {
			handler.processToolUseDelta({ id: "tu1", name: "test" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).input.should.deepEqual({})
		})

		it("handles malformed JSON input gracefully", () => {
			handler.processToolUseDelta({ id: "tu1", name: "test", input: "not json at all" })
			const blocks = handler.getOrderedBlocks()
			blocks.should.have.length(1)
			;(blocks[0] as any).input.should.be.an.Object()
		})

		it("handles concurrent text and tool use with same id (tool use wins)", () => {
			handler.processTextDelta({ id: "shared", text: "text" })
			handler.processToolUseDelta({ id: "shared", name: "tool", input: "{}" })
			const blocks = handler.getOrderedBlocks()
			;(blocks[0] as any).type.should.equal("tool_use")
		})
	})
})
