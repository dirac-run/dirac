import assert from "node:assert/strict"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import { mistralDefaultModelId, mistralModels } from "@/shared/api"
import type { DiracStorageMessage } from "@/shared/messages/content"
import { mockFetchForTesting } from "@/shared/net"
import type { ApiStreamChunk } from "../../transform/stream"
import { MistralHandler } from "../mistral"

const lookupTool: ChatCompletionTool = {
	type: "function",
	function: {
		name: "lookup",
		description: "Look something up",
		parameters: { type: "object", properties: {}, required: [] },
	},
}

async function captureRequest(
	options: ConstructorParameters<typeof MistralHandler>[0],
	messages: DiracStorageMessage[] = [{ role: "user", content: "hello" }],
	tools?: ChatCompletionTool[],
	responseChunks: Record<string, unknown>[] = [{ choices: [] }],
) {
	let request: Record<string, any> | undefined
	const chunks: ApiStreamChunk[] = []
	await mockFetchForTesting(async (_input, init) => {
		request = JSON.parse(init!.body as string)
		const data = responseChunks.map((chunk) => `data: ${JSON.stringify({
			id: "completion-1",
			model: options.apiModelId ?? mistralDefaultModelId,
			...chunk,
		})}\n\n`).join("")
		return new Response(`${data}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
	}, async () => {
		const handler = new MistralHandler({ mistralApiKey: "test-key", disableRetries: true, ...options })
		for await (const chunk of handler.createMessage("system", messages, tools)) chunks.push(chunk)
	})
	assert.ok(request)
	return { request, chunks }
}

describe("MistralHandler", () => {
	it("registers Large 4 with current pricing and supported reasoning levels without changing the default", () => {
		assert.equal(mistralDefaultModelId, "devstral-2512")
		assert.equal(new MistralHandler({}).getModel().id, "devstral-2512")
		assert.equal(new MistralHandler({ apiModelId: "unknown" }).getModel().id, "devstral-2512")
		const { id, info } = new MistralHandler({ apiModelId: "mistral-large-4" }).getModel()
		assert.equal(id, "mistral-large-4")
		assert.equal(info.contextWindow, 1_000_000)
		assert.equal(info.supportsImages, true)
		assert.equal(info.supportsTools, true)
		assert.equal(info.supportsStrictTools, true)
		assert.equal(info.supportsReasoning, true)
		assert.equal(info.supportsReasoningEffort, true)
		assert.deepEqual(info.reasoningEffortOptions, ["low", "medium", "high"])
		assert.equal(info.defaultReasoningEffort, "high")
		assert.equal(info.supportsPromptCache, true)
		assert.equal(info.inputPrice, 0.7)
		assert.equal(info.cacheReadsPrice, 0.07)
		assert.equal(info.outputPrice, 2.1)
		assert.equal(info.temperature, 1)
		assert.equal(info.maxTokens, undefined)
	})

	it("retains all older model IDs", () => {
		for (const apiModelId of [
			"devstral-2512", "labs-devstral-small-2512", "mistral-large-2512", "ministral-14b-2512",
			"mistral-small-latest", "mistral-medium-latest", "mistral-medium-3-5", "mistral-small-2501",
			"open-codestral-mamba", "codestral-2501", "devstral-small-2505", "devstral-medium-latest",
		]) {
			assert.equal(new MistralHandler({ apiModelId }).getModel().id, apiModelId)
		}
		assert.equal(mistralModels["mistral-large-2512"].inputPrice, 0.5)
		assert.equal(mistralModels["mistral-large-2512"].outputPrice, 1.5)
	})

	for (const [reasoningEffort, expected] of [
		[undefined, "high"], ["low", "low"], ["medium", "medium"], ["high", "high"],
		["none", "high"], ["minimal", "high"], ["xhigh", "high"], ["max", "high"],
	] as const) {
		it(`serializes ${reasoningEffort ?? "default"} effort as ${expected} through the installed SDK`, async () => {
			const { request } = await captureRequest({ apiModelId: "mistral-large-4", reasoningEffort })
			assert.equal(request.model, "mistral-large-4")
			assert.equal(request.reasoning_effort, expected)
			assert.equal(request.temperature, 1)
			assert.equal(request.top_p, 0.95)
			assert.equal("max_tokens" in request, false)
			assert.equal("max_completion_tokens" in request, false)
			assert.equal("tools" in request, false)
			assert.equal("tool_choice" in request, false)
		})
	}

	it("preserves older models' temperature, tool choice, and history behavior", async () => {
		const { request } = await captureRequest(
			{ apiModelId: "devstral-2512", reasoningEffort: "medium" },
			[{
				role: "assistant", content: [
					{ type: "thinking", thinking: "private", signature: "" },
					{ type: "text", text: "answer" },
				]
			}],
			[lookupTool],
		)
		assert.equal(request.temperature, 0)
		assert.equal("reasoning_effort" in request, false)
		assert.equal("top_p" in request, false)
		assert.equal(request.tool_choice, "any")
		assert.equal(request.messages[1].content, "answer")
	})

	it("serializes reasoning replay, native tools, and user/tool images", async () => {
		const { request } = await captureRequest({ apiModelId: "mistral-large-4" }, [
			{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] },
			{
				role: "assistant", content: [
					{ type: "thinking", thinking: "inspect the image", signature: "" },
					{ type: "text", text: "checking" },
					{ type: "tool_use", id: "provider_tool_id", name: "lookup", input: {} },
				]
			},
			{
				role: "user", content: [{
					type: "tool_result", tool_use_id: "provider_tool_id", content: [
						{ type: "text", text: "result" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "def" } },
					]
				}]
			},
		], [lookupTool])
		assert.equal(request.tool_choice, "any")
		assert.equal(request.tools[0].function.name, "lookup")
		assert.deepEqual(request.messages[1].content, [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }])
		assert.deepEqual(request.messages[2].content, [
			{ type: "thinking", thinking: [{ type: "text", text: "inspect the image" }], closed: true },
			{ type: "text", text: "checking" },
		])
		const call = request.messages[2].tool_calls[0]
		assert.match(call.id, /^[A-Za-z0-9]{9}$/)
		assert.equal(call.function.arguments, "{}")
		assert.equal(request.messages[3].tool_call_id, call.id)
		assert.deepEqual(request.messages[3].content, [
			{ type: "text", text: "result" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,def" } },
		])
	})

	it("streams thinking, transition text, tools in the same delta, and cache usage without choices", async () => {
		const { chunks } = await captureRequest({ apiModelId: "mistral-large-4" }, undefined, [lookupTool], [
			{
				choices: [{
					index: 0, finish_reason: null, delta: {
						content: [
							{ type: "thinking", thinking: [{ type: "text", text: "reason" }], closed: false },
						]
					}
				}]
			},
			{
				choices: [{
					index: 0, finish_reason: null, delta: {
						content: [
							{ type: "thinking", thinking: [{ type: "text", text: "ing" }], closed: true },
							{ type: "text", text: "checking" },
						],
						tool_calls: [{ index: 0, id: "Call00001", type: "function", function: { name: "lookup", arguments: "{}" } }],
					}
				}]
			},
			{ choices: [{ index: 0, finish_reason: "stop", delta: { content: "done" } }] },
			{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112, prompt_tokens_details: { cached_tokens: 64 } } },
		])
		assert.deepEqual(chunks.slice(0, 3), [
			{ type: "reasoning", reasoning: "reason" },
			{ type: "reasoning", reasoning: "ing" },
			{ type: "text", text: "checking" },
		])
		const toolChunk = chunks[3]
		assert.equal(toolChunk.type, "tool_calls")
		if (toolChunk.type === "tool_calls") {
			assert.equal(toolChunk.tool_call.call_id, "Call00001")
			assert.equal(toolChunk.tool_call.function.name, "lookup")
			assert.equal(toolChunk.tool_call.function.arguments, "{}")
		}
		assert.deepEqual(chunks.slice(4), [
			{ type: "text", text: "done" },
			{ type: "usage", inputTokens: 36, outputTokens: 12, cacheReadTokens: 64 },
		])
	})
})
