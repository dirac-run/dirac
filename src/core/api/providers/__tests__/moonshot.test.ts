import "should"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import sinon from "sinon"
import { moonshotDefaultModelId, moonshotModels } from "@/shared/api"
import type { DiracStorageMessage } from "@/shared/messages/content"
import { mockFetchForTesting } from "@/shared/net"
import { MoonshotHandler } from "../moonshot"

const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

const proModelIds = ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"] as const
const lookupTool: OpenAITool = {
	type: "function",
	function: {
		name: "lookup",
		description: "Look something up",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	},
}

describe("MoonshotHandler", () => {
	afterEach(() => sinon.restore())

	const captureRequest = async (
		handler: MoonshotHandler,
		messages: DiracStorageMessage[] = [{ role: "user", content: "hi" }],
		tools?: OpenAITool[],
	) => {
		const create = sinon.stub().resolves(createAsyncIterable())
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } } as any)

		for await (const _chunk of handler.createMessage("system", messages, tools)) {
			// Consume the stream so the request is issued.
		}

		return create.firstCall.args[0]
	}

	it("keeps kimi-k3 as the default model with its fixed reasoning metadata", () => {
		moonshotDefaultModelId.should.equal("kimi-k3")
		moonshotModels["kimi-k3"].should.deepEqual({
			maxTokens: 131_072,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsReasoning: true,
			supportsReasoningEffort: true,
			reasoningEffortOptions: ["max"],
			defaultReasoningEffort: "max",
			thinkingAlwaysOn: true,
			supportsTools: true,
			supportsPromptCache: true,
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheReadsPrice: 0.3,
			isR1FormatRequired: true,
		})
	})

	for (const apiModelId of proModelIds) {
		it(`registers the published PAYG capabilities and default-5m pricing for ${apiModelId}`, () => {
			const isHighspeed = apiModelId === "kimi-k3.1-pro-highspeed"
			const model = new MoonshotHandler({ apiModelId }).getModel()
			model.id.should.equal(apiModelId)
			model.info.should.deepEqual({
				maxTokens: 1_048_576,
				contextWindow: 1_048_576,
				supportsImages: true,
				supportsReasoning: true,
				supportsReasoningEffort: true,
				reasoningEffortOptions: ["low", "high", "max"],
				defaultReasoningEffort: "max",
				thinkingAlwaysOn: true,
				supportsTools: true,
				supportsPromptCache: true,
				inputPrice: isHighspeed ? 4.0 : 2.0,
				outputPrice: isHighspeed ? 20.0 : 10.0,
				cacheReadsPrice: 0.2,
				cacheWritesPrice: isHighspeed ? 4.0 : 2.0,
				isR1FormatRequired: true,
			})
		})

		for (const reasoningEffort of [undefined, "low", "high", "max", "none", "medium", "invalid"]) {
			it(`uses valid top-level reasoning and fixed completion defaults for ${apiModelId} (${reasoningEffort})`, async () => {
				const request = await captureRequest(new MoonshotHandler({ apiModelId, reasoningEffort }))
				request.model.should.equal(apiModelId)
				request.max_completion_tokens.should.equal(131_072)
				request.reasoning_effort.should.equal(
					reasoningEffort === "low" || reasoningEffort === "high" ? reasoningEffort : "max",
				)
				for (const field of [
					"max_tokens",
					"temperature",
					"top_p",
					"n",
					"presence_penalty",
					"frequency_penalty",
					"thinking",
					"extra_body",
				]) {
					request.should.not.have.property(field)
				}
			})
		}

		it(`replays prior reasoning, tool calls, and tool results for ${apiModelId}`, async () => {
			const request = await captureRequest(
				new MoonshotHandler({ apiModelId }),
				[
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "prior reasoning", signature: "" },
							{ type: "text", text: "prior answer" },
						],
					},
					{ role: "user", content: "continue" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "look up the answer", signature: "" },
							{ type: "tool_use", id: "call_1", name: "lookup", input: {} },
						],
					},
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "answer" }] },
				],
				[lookupTool],
			)

			request.messages.should.deepEqual([
				{ role: "system", content: "system" },
				{ role: "assistant", content: "prior answer", reasoning_content: "prior reasoning" },
				{ role: "user", content: "continue" },
				{
					role: "assistant",
					content: "",
					reasoning_content: "look up the answer",
					tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "call_1", content: "answer" },
			])
			request.tools[0].function.name.should.equal("lookup")
		})

		it(`sends base64 image input as a content array for ${apiModelId}`, async () => {
			const request = await captureRequest(new MoonshotHandler({ apiModelId }), [
				{
					role: "user",
					content: [
						{ type: "text", text: "What is in this image?" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
					],
				},
			])
			request.messages[1].content.should.deepEqual([
				{ type: "text", text: "What is in this image?" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
			])
		})

		for (const moonshotApiLine of [undefined, "china"]) {
			it(`serializes ${apiModelId} through the ${moonshotApiLine ?? "international"} PAYG endpoint`, async () => {
				let request: Record<string, any> | undefined
				let requestUrl: string | undefined
				await mockFetchForTesting(
					async (input, init) => {
						requestUrl = String(input)
						request = JSON.parse(init!.body as string)
						return new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', {
							headers: { "Content-Type": "text/event-stream" },
						})
					},
					async () => {
						const handler = new MoonshotHandler({
							apiModelId,
							moonshotApiLine,
							moonshotApiKey: "test-key",
							reasoningEffort: "low",
						})
						const chunks = []
						for await (const chunk of handler.createMessage("system", [{ role: "user", content: "ping" }]))
							chunks.push(chunk)
						chunks.should.deepEqual([{ type: "text", text: "pong" }])
					},
				)
				requestUrl!.should.equal(
					moonshotApiLine === "china"
						? "https://api.moonshot.cn/v1/chat/completions"
						: "https://api.moonshot.ai/v1/chat/completions",
				)
				request!.model.should.equal(apiModelId)
				request!.reasoning_effort.should.equal("low")
				request!.max_completion_tokens.should.equal(131_072)
				request!.should.not.have.property("temperature")
				request!.should.not.have.property("max_tokens")
			})
		}
	}

	it("keeps K3's fixed reasoning and completion parameters regardless of the requested effort", async () => {
		const request = await captureRequest(new MoonshotHandler({ reasoningEffort: "low" }))
		request.model.should.equal("kimi-k3")
		request.max_completion_tokens.should.equal(131_072)
		request.reasoning_effort.should.equal("max")
		for (const field of ["max_tokens", "temperature", "top_p", "n", "presence_penalty", "frequency_penalty"]) {
			request.should.not.have.property(field)
		}
	})

	for (const apiModelId of ["kimi-k2.6", "kimi-k2.5", "kimi-k2-0905-preview", "kimi-k2-thinking-turbo"] as const) {
		it(`keeps the existing request parameters for ${apiModelId}`, async () => {
			const request = await captureRequest(new MoonshotHandler({ apiModelId, reasoningEffort: "low" }))
			request.model.should.equal(apiModelId)
			request.max_tokens.should.equal(moonshotModels[apiModelId].maxTokens)
			request.temperature.should.equal(moonshotModels[apiModelId].temperature)
			request.should.not.have.property("max_completion_tokens")
			request.should.not.have.property("reasoning_effort")
		})
	}

	it("does not register the Coding Plan model IDs in the PAYG catalog", () => {
		moonshotModels.should.not.have.property("k3.1-pro")
		moonshotModels.should.not.have.property("k3.1-pro-highspeed")
		new MoonshotHandler({ apiModelId: "k3.1-pro" }).getModel().id.should.equal("kimi-k3")
	})

	it("streams reasoning, tool calls, text, and the nested cache usage breakdown", async () => {
		const handler = new MoonshotHandler({ apiModelId: "kimi-k3.1-pro" })
		const create = sinon.stub().resolves(
			createAsyncIterable([
				{ choices: [{ delta: { reasoning_content: "think" } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										type: "function",
										function: { name: "lookup", arguments: "{}" },
									},
								],
							},
						},
					],
				},
				{ choices: [{ delta: { content: "answer" } }] },
				{
					choices: [],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 20,
						cached_tokens: 99,
						prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
					},
				},
			]),
		)
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })
		const chunks = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.containDeep([
			{ type: "reasoning", reasoning: "think" },
			{ type: "text", text: "answer" },
		])
		chunks.some((chunk) => chunk.type === "tool_calls").should.equal(true)
		chunks[chunks.length - 1].should.deepEqual({
			type: "usage",
			cacheWriteTokens: 30,
			cacheReadTokens: 60,
			inputTokens: 10,
			outputTokens: 20,
		})
	})

	it("preserves legacy top-level cache usage accounting", async () => {
		const handler = new MoonshotHandler({ apiModelId: "kimi-k2.6" })
		const create = sinon
			.stub()
			.resolves(
				createAsyncIterable([{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 60 } }]),
			)
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })
		const chunks = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([{ type: "usage", cacheWriteTokens: 0, cacheReadTokens: 60, inputTokens: 40, outputTokens: 20 }])
	})

	it("keeps K3 cache writes in input usage while its separate write price is unspecified", async () => {
		const handler = new MoonshotHandler({ apiModelId: "kimi-k3" })
		const create = sinon.stub().resolves(
			createAsyncIterable([
				{
					choices: [],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 20,
						prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
					},
				},
			]),
		)
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })
		const chunks = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		chunks.should.deepEqual([{ type: "usage", cacheWriteTokens: 0, cacheReadTokens: 60, inputTokens: 40, outputTokens: 20 }])
	})
})
