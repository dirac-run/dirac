import "should"
import type { Anthropic } from "@anthropic-ai/sdk"
import { convertToMistralMessages } from "../mistral-format"

describe("convertToMistralMessages", () => {
	it("passes through string content with role", () => {
		convertToMistralMessages([{ role: "user", content: "hello" } as any]).should.deepEqual([
			{ role: "user", content: "hello" },
		])
	})

	it("converts direct user text and images", () => {
		const result = convertToMistralMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "inspect" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
					{ type: "image", source: { type: "url", url: "https://x.com/i.png" } as any },
				],
			} as Anthropic.Messages.MessageParam,
		])
		result.should.deepEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "inspect" },
					{ type: "image_url", imageUrl: { url: "data:image/png;base64,abc" } },
					{ type: "image_url", imageUrl: { url: "https://x.com/i.png" } },
				],
			},
		])
	})

	it("replaces direct images with placeholders when images are unsupported", () => {
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

	it("preserves assistant native tool calls", () => {
		const result = convertToMistralMessages([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "checking" },
					{ type: "tool_use", id: "Call00001", name: "read_file", input: { path: "image.png" } },
				],
			} as any,
		])
		result.should.deepEqual([
			{
				role: "assistant",
				content: "checking",
				toolCalls: [
					{
						id: "Call00001",
						index: 0,
						type: "function",
						function: { name: "read_file", arguments: '{"path":"image.png"}' },
					},
				],
			},
		])
	})

	it("normalizes provider tool call IDs to stable Mistral IDs", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_provider_specific_id", name: "read_file", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_provider_specific_id", content: "done" }],
			},
		] as any

		const first = convertToMistralMessages(messages)
		const second = convertToMistralMessages(messages)
		const toolCallId = (first[0] as any).toolCalls[0].id

		toolCallId.should.match(/^[A-Za-z0-9]{9}$/)
			; (first[1] as any).toolCallId.should.equal(toolCallId)
			; (second[0] as any).toolCalls[0].id.should.equal(toolCallId)
	})

	it("emits native tool messages with matching call identity", () => {
		const result = convertToMistralMessages([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "Call00001", name: "read_file", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "Call00001", content: "file contents" }],
			},
		] as any)
		result.should.deepEqual([
			{
				role: "assistant",
				content: null,
				toolCalls: [{ id: "Call00001", index: 0, type: "function", function: { name: "read_file", arguments: "{}" } }],
			},
			{
				role: "tool",
				toolCallId: "Call00001",
				name: "read_file",
				content: [{ type: "text", text: "file contents" }],
			},
		])
	})

	it("preserves image-bearing tool results in native tool content", () => {
		const result = convertToMistralMessages([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "Call00001", name: "read_file", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "Call00001",
						content: [
							{ type: "text", text: "image contents" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
						],
					},
				],
			},
		] as any)
		result[1].should.deepEqual({
			role: "tool",
			toolCallId: "Call00001",
			name: "read_file",
			content: [
				{ type: "text", text: "image contents" },
				{ type: "image_url", imageUrl: { url: "data:image/png;base64,abc" } },
			],
		})
	})

	it("emits tool results before ordinary user content from the same turn", () => {
		const result = convertToMistralMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "continue" },
					{ type: "tool_result", tool_use_id: "Call00001", content: "done" },
				],
			},
		] as any)
		result.should.deepEqual([
			{
				role: "tool",
				toolCallId: "Call00001",
				name: undefined,
				content: [{ type: "text", text: "done" }],
			},
			{ role: "user", content: [{ type: "text", text: "continue" }] },
		])
	})

	it("replays reasoning in order alongside assistant text and tool calls when enabled", () => {
		const result = convertToMistralMessages([
			{
				role: "assistant", content: [
					{ type: "thinking", thinking: "first thought", signature: "" },
					{ type: "text", text: "checking" },
					{ type: "thinking", thinking: "second thought", signature: "" },
					{ type: "tool_use", id: "Call00001", name: "lookup", input: {} },
				]
			},
		], true, true)
		result.should.deepEqual([{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: [{ type: "text", text: "first thought" }], closed: true },
				{ type: "text", text: "checking" },
				{ type: "thinking", thinking: [{ type: "text", text: "second thought" }], closed: true },
			],
			toolCalls: [{ id: "Call00001", index: 0, type: "function", function: { name: "lookup", arguments: "{}" } }],
		}])
	})

	it("retains reasoning-only assistant turns when replay is enabled", () => {
		convertToMistralMessages([
			{ role: "assistant", content: [{ type: "thinking", thinking: "continue thinking", signature: "" }] },
		], true, true).should.deepEqual([{
			role: "assistant",
			content: [{ type: "thinking", thinking: [{ type: "text", text: "continue thinking" }], closed: true }],
		}])
	})

	it("keeps legacy string content when reasoning replay is enabled without any thoughts", () => {
		convertToMistralMessages([
			{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
		], true, true).should.deepEqual([{ role: "assistant", content: "first\nsecond" }])
	})

	it("skips assistant messages with no supported content", () => {
		convertToMistralMessages([
			{ role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "sig" } as any] },
		] as any).should.have.length(0)
	})
})
