import "should"
import { convertToMistralMessages } from "../mistral-format"
import type { Anthropic } from "@anthropic-ai/sdk"

// Characterization tests for convertToMistralMessages.
// Mistral only accepts text and image_url blocks for users, text-only for assistants.
describe("convertToMistralMessages", () => {
	it("passes through string content with role", () => {
		const result = convertToMistralMessages([{ role: "user", content: "hello" } as any])
		result.should.deepEqual([{ role: "user", content: "hello" }])
	})

	it("passes through assistant string content", () => {
		const result = convertToMistralMessages([{ role: "assistant", content: "hi" } as any])
		result.should.deepEqual([{ role: "assistant", content: "hi" }])
	})

	it("converts user text blocks to string content", () => {
		const result = convertToMistralMessages([
			{ role: "user", content: [{ type: "text", text: "hello" }] } as Anthropic.Messages.MessageParam,
		])
		result.should.deepEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }])
	})

	it("converts base64 image to image_url when supportsImages=true", () => {
		const result = convertToMistralMessages(
			[
				{
					role: "user",
					content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
				} as Anthropic.Messages.MessageParam,
			],
			true,
		)
		result.should.deepEqual([
			{ role: "user", content: [{ type: "image_url", imageUrl: { url: "data:image/png;base64,abc" } }] },
		])
	})

	it("converts url image to image_url when supportsImages=true", () => {
		const result = convertToMistralMessages(
			[
				{
					role: "user",
					content: [{ type: "image", source: { type: "url", url: "https://x.com/i.png" } as any }],
				} as Anthropic.Messages.MessageParam,
			],
			true,
		)
		result.should.deepEqual([{ role: "user", content: [{ type: "image_url", imageUrl: { url: "https://x.com/i.png" } }] }])
	})

	it("replaces image with [Image] text when supportsImages=false", () => {
		const result = convertToMistralMessages(
			[
				{
					role: "user",
					content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
				} as Anthropic.Messages.MessageParam,
			],
			false,
		)
		result.should.deepEqual([{ role: "user", content: [{ type: "text", text: "[Image]" }] }])
	})

	it("filters out non-text/image blocks for user role", () => {
		const result = convertToMistralMessages([
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "r" } as any, { type: "text", text: "keep" }],
			},
		] as any)
		result.should.deepEqual([{ role: "user", content: [{ type: "text", text: "keep" }] }])
	})

	it("skips user messages with no text/image blocks", () => {
		const result = convertToMistralMessages([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" } as any] },
		] as any)
		result.should.have.length(0)
	})

	it("converts assistant text blocks to joined string", () => {
		const result = convertToMistralMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "line1" },
					{ type: "text", text: "line2" },
				],
			},
		] as any)
		result.should.deepEqual([{ role: "assistant", content: "line1\nline2" }])
	})

	it("filters out non-text blocks for assistant role", () => {
		const result = convertToMistralMessages([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "fn", input: {} } as any, { type: "text", text: "keep" }],
			},
		] as any)
		result.should.deepEqual([{ role: "assistant", content: "keep" }])
	})

	it("skips assistant messages with no text blocks", () => {
		const result = convertToMistralMessages([
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: {} } as any] },
		] as any)
		result.should.have.length(0)
	})
})
