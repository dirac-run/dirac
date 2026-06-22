import "should"
import { DiracStorageMessage } from "@/shared/messages/content"
import { addReasoningContent, convertToR1Format } from "../r1-format"

// Characterization tests for DeepSeek R1 format transforms.
// addReasoningContent: re-attaches thinking blocks as reasoning_content on OpenAI assistant messages.
// convertToR1Format: converts Anthropic message params to DeepSeek reasoner format with role merging + reasoning_content.
describe("r1-format", () => {
	describe("addReasoningContent", () => {
		it("attaches thinking content as reasoning_content on assistant messages", () => {
			const openAiMessages = [{ role: "assistant", content: "hi" }] as any
			const originalMessages: DiracStorageMessage[] = [
				{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" } as any] } as any,
			]
			const result = addReasoningContent(openAiMessages, originalMessages)
			;(result[0] as any).reasoning_content.should.equal("hmm")
			;(result[0] as any).content.should.equal("hi")
		})

		it("joins multiple thinking blocks with newline", () => {
			const openAiMessages = [{ role: "assistant", content: "x" }] as any
			const originalMessages: DiracStorageMessage[] = [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "step1", signature: "s" },
						{ type: "thinking", thinking: "step2", signature: "s" },
					] as any,
				} as any,
			]
			const result = addReasoningContent(openAiMessages, originalMessages)
			;(result[0] as any).reasoning_content.should.equal("step1\nstep2")
		})

		it("skips non-thinking content blocks when extracting thinking", () => {
			const openAiMessages = [{ role: "assistant", content: "x" }] as any
			const originalMessages: DiracStorageMessage[] = [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "answer" },
						{ type: "thinking", thinking: "only-me", signature: "s" },
						{ type: "tool_use", id: "t1", name: "fn", input: {} },
					] as any,
				} as any,
			]
			const result = addReasoningContent(openAiMessages, originalMessages)
			;(result[0] as any).reasoning_content.should.equal("only-me")
		})

		it("defaults reasoning_content to empty string when assistant has no thinking blocks", () => {
			const openAiMessages = [{ role: "assistant", content: "x" }] as any
			const originalMessages: DiracStorageMessage[] = [
				{ role: "assistant", content: [{ type: "text", text: "answer" } as any] } as any,
			]
			const result = addReasoningContent(openAiMessages, originalMessages)
			;(result[0] as any).reasoning_content.should.equal("")
		})

		it("always includes reasoning_content even when no original assistant message matches", () => {
			const openAiMessages = [{ role: "assistant", content: "x" }] as any
			const result = addReasoningContent(openAiMessages, [])
			;(result[0] as any).reasoning_content.should.equal("")
		})

		it("with onlyIfToolCall=true, omits reasoning_content when assistant has no tool_use", () => {
			const openAiMessages = [{ role: "assistant", content: "x" }] as any
			const originalMessages: DiracStorageMessage[] = [
				{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" } as any] } as any,
			]
			const result = addReasoningContent(openAiMessages, originalMessages, { onlyIfToolCall: true })
			// shouldInclude is false -> falls through to reasoning_content: ""
			;(result[0] as any).reasoning_content.should.equal("")
		})

		it("with onlyIfToolCall=true, includes reasoning_content when assistant has tool_use", () => {
			const openAiMessages = [{ role: "assistant", content: "x" }] as any
			const originalMessages: DiracStorageMessage[] = [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", signature: "s" },
						{ type: "tool_use", id: "t1", name: "fn", input: {} },
					] as any,
				} as any,
			]
			const result = addReasoningContent(openAiMessages, originalMessages, { onlyIfToolCall: true })
			;(result[0] as any).reasoning_content.should.equal("plan")
		})

		it("pairs assistant messages by index across multiple turns", () => {
			const openAiMessages = [
				{ role: "assistant", content: "a1" },
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a2" },
			] as any
			const originalMessages: DiracStorageMessage[] = [
				{ role: "assistant", content: [{ type: "thinking", thinking: "first", signature: "s" } as any] } as any,
				{ role: "user", content: "u" } as any,
				{ role: "assistant", content: [{ type: "thinking", thinking: "second", signature: "s" } as any] } as any,
			]
			const result = addReasoningContent(openAiMessages, originalMessages)
			;(result[0] as any).reasoning_content.should.equal("first")
			;(result[1] as any).role.should.equal("user")
			;(result[2] as any).reasoning_content.should.equal("second")
		})

		it("passes through non-assistant messages unchanged", () => {
			const openAiMessages = [
				{ role: "user", content: "hello" },
				{ role: "system", content: "sys" },
			] as any
			const result = addReasoningContent(openAiMessages, [])
			result.should.have.length(2)
			;(result[0] as any).role.should.equal("user")
			;(result[1] as any).role.should.equal("system")
			should.equal((result[0] as any).reasoning_content, undefined)
		})

		it("handles string content on assistant original message (no thinking extracted)", () => {
			const openAiMessages = [{ role: "assistant", content: "x" }] as any
			const originalMessages: DiracStorageMessage[] = [{ role: "assistant", content: "raw string" } as any]
			const result = addReasoningContent(openAiMessages, originalMessages)
			;(result[0] as any).reasoning_content.should.equal("")
		})
	})

	describe("convertToR1Format", () => {
		it("passes through string content with role", () => {
			const result = convertToR1Format([{ role: "user", content: "hello" }] as any)
			result.should.have.length(1)
			;(result[0] as any).role.should.equal("user")
			;(result[0] as any).content.should.equal("hello")
		})

		it("converts array text parts to joined string", () => {
			const result = convertToR1Format([
				{
					role: "user",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			] as any)
			;(result[0] as any).content.should.equal("a\nb")
		})

		it("treats empty text part as empty string when joining", () => {
			const result = convertToR1Format([{ role: "user", content: [{ type: "text" }, { type: "text", text: "b" }] }] as any)
			;(result[0] as any).content.should.equal("\nb")
		})

		it("replaces image with [Image] text when supportsImages=false", () => {
			const result = convertToR1Format(
				[{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }],
				false,
			)
			;(result[0] as any).content.should.equal("[Image]")
		})

		it("converts base64 image to image_url when supportsImages=true", () => {
			const result = convertToR1Format(
				[
					{
						role: "user",
						content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
					},
				],
				true,
			)
			const content = (result[0] as any).content
			content.should.have.length(1)
			content[0].should.deepEqual({ type: "image_url", image_url: { url: "data:image/png;base64,abc" } })
		})

		it("converts url image to image_url when supportsImages=true", () => {
			const result = convertToR1Format(
				[{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x.com/i.png" } as any }] }],
				true,
			)
			const content = (result[0] as any).content
			content[0].should.deepEqual({ type: "image_url", image_url: { url: "https://x.com/i.png" } })
		})

		it("combines text and image parts into content array when supportsImages=true", () => {
			const result = convertToR1Format(
				[
					{
						role: "user",
						content: [
							{ type: "text", text: "look" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "d" } },
						],
					},
				],
				true,
			)
			const content = (result[0] as any).content
			content.should.have.length(2)
			content[0].should.deepEqual({ type: "text", text: "look" })
			content[1].type.should.equal("image_url")
		})

		it("omits text part when only image present and supportsImages=true", () => {
			const result = convertToR1Format(
				[{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "d" } }] }],
				true,
			)
			const content = (result[0] as any).content
			content.should.have.length(1)
			content[0].type.should.equal("image_url")
		})

		it("extracts thinking into reasoning_content for assistant messages", () => {
			const result = convertToR1Format([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", signature: "s" },
						{ type: "text", text: "ans" },
					],
				},
			] as any)
			;(result[0] as any).reasoning_content.should.equal("plan")
			;(result[0] as any).content.should.equal("ans")
		})

		it("joins multiple thinking blocks with newline in reasoning_content", () => {
			const result = convertToR1Format([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "p1", signature: "s" },
						{ type: "thinking", thinking: "p2", signature: "s" },
						{ type: "text", text: "ans" },
					],
				},
			] as any)
			;(result[0] as any).reasoning_content.should.equal("p1\np2")
		})

		it("sets reasoning_content to empty string for assistant without thinking", () => {
			const result = convertToR1Format([{ role: "assistant", content: [{ type: "text", text: "ans" }] }] as any)
			;(result[0] as any).reasoning_content.should.equal("")
		})

		it("merges consecutive same-role string contents with newline", () => {
			const result = convertToR1Format([
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			] as any)
			result.should.have.length(1)
			;(result[0] as any).content.should.equal("first\nsecond")
		})

		it("merges consecutive same-role text-only contents as joined string", () => {
			const result = convertToR1Format([
				{ role: "user", content: [{ type: "text", text: "a" }] },
				{ role: "user", content: [{ type: "text", text: "b" }] },
			] as any)
			result.should.have.length(1)
			;(result[0] as any).content.should.equal("a\nb")
		})

		it("merges consecutive same-role string contents as joined string", () => {
			const result = convertToR1Format([
				{ role: "user", content: "str" },
				{ role: "user", content: [{ type: "text", text: "arr" }] },
			] as any)
			result.should.have.length(1)
			;(result[0] as any).content.should.equal("str\narr")
		})

		it("merges consecutive same-role contents as array when images present", () => {
			const result = convertToR1Format(
				[
					{ role: "user", content: [{ type: "text", text: "a" }] },
					{
						role: "user",
						content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "d" } }],
					},
				],
				true,
			)
			result.should.have.length(1)
			const content = (result[0] as any).content
			Array.isArray(content).should.be.true()
			content.should.have.length(2)
		})

		it("drops thinking content when merging consecutive assistant string contents (characterizes merge bug)", () => {
			const result = convertToR1Format([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "p1", signature: "s" },
						{ type: "text", text: "a" },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "p2", signature: "s" },
						{ type: "text", text: "b" },
					],
				},
			] as any)
			result.should.have.length(1)
			// thinking merge only runs in the array-merge branch; string-merge drops the second thinking
			;(result[0] as any).reasoning_content.should.equal("p1")
			;(result[0] as any).content.should.equal("a\nb")
		})

		it("merges thinking content across consecutive assistant messages when images force array merge", () => {
			const result = convertToR1Format(
				[
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "p1", signature: "s" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "d" } },
						],
					},
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "p2", signature: "s" },
							{ type: "text", text: "b" },
						],
					},
				],
				true,
			)
			result.should.have.length(1)
			;(result[0] as any).reasoning_content.should.equal("p1\np2")
		})

		it("does not merge across different roles", () => {
			const result = convertToR1Format([
				{ role: "user", content: "u" },
				{ role: "assistant", content: "a" },
			] as any)
			result.should.have.length(2)
			;(result[0] as any).role.should.equal("user")
			;(result[1] as any).role.should.equal("assistant")
		})

		it("defaults supportsImages to false", () => {
			const result = convertToR1Format([
				{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] },
			] as any)
			;(result[0] as any).content.should.equal("[Image]")
		})

		it("handles empty message array", () => {
			const result = convertToR1Format([])
			result.should.deepEqual([])
		})

		it("handles assistant with only thinking and no text", () => {
			const result = convertToR1Format([
				{ role: "assistant", content: [{ type: "thinking", thinking: "only", signature: "s" }] },
			] as any)
			;(result[0] as any).reasoning_content.should.equal("only")
			;(result[0] as any).content.should.equal("")
		})
	})
})
