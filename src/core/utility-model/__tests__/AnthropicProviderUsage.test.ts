import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { AnthropicHandler } from "@core/api/providers/anthropic"
import { VertexHandler } from "@core/api/providers/vertex"
import { AIhubmixHandler } from "@core/api/providers/aihubmix"
import type { ApiStreamChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import { UtilityModelRunner } from "../UtilityModelRunner"

const start = {
	type: "message_start", message: {
		usage: {
			input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 30, cache_read_input_tokens: 20, speed: "fast",
		}
	},
}
const delta = (output_tokens?: number) => ({ type: "message_delta", usage: { output_tokens }, delta: { stop_reason: "end_turn" } })
const stream = (chunks: unknown[]) => ({ async *[Symbol.asyncIterator]() { yield* chunks } })
async function collect(chunks: AsyncIterable<ApiStreamChunk>) {
	const result: ApiStreamChunk[] = []
	for await (const chunk of chunks) result.push(chunk)
	return result
}

for (const provider of ["anthropic", "vertex", "aihubmix"] as const) {
	describe(`${provider} cumulative Anthropic usage`, () => {
		afterEach(() => sinon.restore())

		function fixture(chunks: unknown[]) {
			const create = sinon.stub().resolves(stream(chunks))
			if (provider === "anthropic") {
				const handler = new AnthropicHandler({ apiKey: "test", apiModelId: "claude-sonnet-4-6" })
				sinon.stub(handler as any, "ensureClient").returns({ messages: { create } })
				return { handler, create }
			}
			if (provider === "vertex") {
				const handler = new VertexHandler({ vertexProjectId: "test", vertexRegion: "us-east1", apiModelId: "claude-sonnet-4-6" })
				sinon.stub(handler as any, "ensureAnthropicClient").returns({ beta: { messages: { create } } })
				return { handler, create }
			}
			const handler = new AIhubmixHandler({ apiKey: "test", modelId: "claude-sonnet-4-6" })
			sinon.stub(handler as any, "ensureAnthropicClient").returns({ messages: { create } })
			return { handler, create }
		}

		it("carries request input/cache and metadata across multiple cumulative output updates", async () => {
			const { handler } = fixture([start, delta(5), delta(9), delta()])
			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))
			const usages = chunks as ApiStreamUsageChunk[]
			assert.deepEqual(usages.map(({ inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }) =>
				({ inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens })), [1, 5, 9, 9].map((outputTokens) => ({
					inputTokens: 100, outputTokens, cacheWriteTokens: 30, cacheReadTokens: 20,
				})))
			if (provider === "anthropic") {
				assert.ok(usages.every((usage) => usage.inferenceSpeed === "fast"))
				assert.equal(usages[1].stopReason, "end_turn")
			}
			assert.equal(usages[0].outputTokens, 1, "later updates must not mutate already yielded snapshots")
		})

		it("Utility accounting sums real provider snapshots only once and resets each request", async () => {
			const { handler, create } = fixture([start, delta(5), delta(9), delta(9)])
			const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
			const runner = new UtilityModelRunner({ provider, modelId: "claude-sonnet-4-6" }, () => handler, {
				onUsage: ({ usage }) => {
					totals.input += usage.inputTokens
					totals.output += usage.outputTokens
					totals.cacheWrite += usage.cacheWriteTokens ?? 0
					totals.cacheRead += usage.cacheReadTokens ?? 0
				},
			})
			await collect(runner.run({ systemPrompt: "system", messages: [{ role: "user", content: "hello" }] }))
			assert.deepEqual(totals, { input: 100, output: 9, cacheWrite: 30, cacheRead: 20 })
			create.resolves(stream([delta(4)]))
			const isolated = await collect(handler.createMessage("system", [{ role: "user", content: "next" }]))
			assert.deepEqual(isolated, [{
				type: "usage", inputTokens: 0, outputTokens: 4,
				...(provider === "anthropic" ? { stopReason: "end_turn" } : {})
			}])
		})

		it("keeps usage local when two streams use the same handler", async () => {
			const { handler, create } = fixture([])
			create.onFirstCall().resolves(stream([start, delta(9)]))
			create.onSecondCall().resolves(stream([{ ...start, message: { usage: { input_tokens: 7 } } }, delta(3)]))
			const first = handler.createMessage("system", [{ role: "user", content: "one" }])[Symbol.asyncIterator]()
			const second = handler.createMessage("system", [{ role: "user", content: "two" }])[Symbol.asyncIterator]()
			await first.next()
			await second.next()
			assert.equal(((await first.next()).value as ApiStreamUsageChunk).inputTokens, 100)
			assert.equal(((await second.next()).value as ApiStreamUsageChunk).inputTokens, 7)
			await first.return?.(undefined)
			await second.return?.(undefined)
		})
	})
}
