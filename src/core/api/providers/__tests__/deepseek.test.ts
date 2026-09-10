import "should"
import sinon from "sinon"
import { deepSeekModels } from "@/shared/api"
import { DeepSeekHandler } from "../deepseek"

const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

describe("DeepSeekHandler", () => {
	afterEach(() => sinon.restore())

	it("registers only DeepSeek V4.1 Flash with multimodal support and current pricing", () => {
		Object.keys(deepSeekModels).should.deepEqual(["deepseek-flash"])
		deepSeekModels["deepseek-flash"].should.deepEqual({
			maxTokens: 384_000,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsReasoningEffort: true,
			reasoningEffortOptions: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
			defaultReasoningEffort: "high",
			supportsTools: true,
			inputPrice: 0,
			outputPrice: 0.6,
			cacheWritesPrice: 0.15,
			cacheReadsPrice: 0.003,
			pricingSchedule: {
				timeZone: "UTC",
				defaultLabel: "Off-peak",
				periods: [
					{
						label: "Peak",
						weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
						startMinuteUtc: 60,
						endMinuteUtc: 240,
						prices: { inputPrice: 0, outputPrice: 1.2, cacheWritesPrice: 0.3, cacheReadsPrice: 0.006 },
					},
					{
						label: "Peak",
						weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
						startMinuteUtc: 360,
						endMinuteUtc: 600,
						prices: { inputPrice: 0, outputPrice: 1.2, cacheWritesPrice: 0.3, cacheReadsPrice: 0.006 },
					},
				],
			},
		})
	})

	it("normalizes retired DeepSeek model IDs to the canonical Flash model", () => {
		for (const apiModelId of [
			"deepseek-v4-flash",
			"deepseek-v4-flash-vision-exp",
			"deepseek-v4-pro",
			"deepseek-chat",
			"deepseek-reasoner",
		]) {
			new DeepSeekHandler({ deepSeekApiKey: "test-api-key", apiModelId }).getModel().id.should.equal("deepseek-flash")
		}
	})

	it("sends images to DeepSeek V4.1 Flash as OpenAI image URL blocks", async () => {
		const create = sinon.stub().resolves(createAsyncIterable())
		const handler = new DeepSeekHandler({
			deepSeekApiKey: "test-api-key",
			apiModelId: "deepseek-flash",
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		for await (const _chunk of handler.createMessage("system", [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
				],
			},
		])) {
			// Consume the stream so the request is issued.
		}

		const request = create.firstCall.args[0]
		request.model.should.equal("deepseek-flash")
		request.max_tokens.should.equal(384_000)
		request.messages.should.deepEqual([
			{ role: "system", content: "system" },
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
				],
			},
		])
	})

	it("sends images returned by tools in a following user message", async () => {
		const create = sinon.stub().resolves(createAsyncIterable())
		const handler = new DeepSeekHandler({
			deepSeekApiKey: "test-api-key",
			apiModelId: "deepseek-flash",
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		for await (const _chunk of handler.createMessage("system", [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "read_file", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: [
							{ type: "text", text: "Successfully read image" },
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: "BASE64_SENTINEL" },
							},
						],
					},
				],
			},
		])) {
			// Consume the stream so the request is issued.
		}

		create.firstCall.args[0].messages.should.deepEqual([
			{ role: "system", content: "system" },
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
				reasoning_content: "",
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				content: "Successfully read image\n(see following user message for image)",
			},
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BASE64_SENTINEL" } }],
			},
		])
	})

	it("replays reasoning from every prior assistant turn when tools are present", async () => {
		const create = sinon.stub().resolves(createAsyncIterable())
		const handler = new DeepSeekHandler({
			deepSeekApiKey: "test-api-key",
			apiModelId: "deepseek-flash",
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		for await (const _chunk of handler.createMessage(
			"system",
			[
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "prior reasoning", signature: "" },
						{ type: "text", text: "prior answer" },
					],
				},
				{ role: "user", content: [{ type: "text", text: "continue" }] },
			],
			[
				{
					type: "function",
					function: {
						name: "lookup",
						description: "Look something up",
						parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
					},
				},
			],
		)) {
			// Consume the stream so the request is issued.
		}

		const request = create.firstCall.args[0]
		request.messages[1].should.deepEqual({
			role: "assistant",
			content: "prior answer",
			reasoning_content: "prior reasoning",
		})
		request.tools[0].function.strict.should.equal(true)
		request.extra_body.should.deepEqual({ thinking: { type: "enabled" } })
		request.should.not.have.property("budget_tokens")
	})

})
