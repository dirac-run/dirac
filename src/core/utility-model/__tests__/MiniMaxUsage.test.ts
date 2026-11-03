import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { MinimaxHandler } from "@core/api/providers/minimax"
import type { ApiStreamChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import { UtilityModelRunner } from "../UtilityModelRunner"

const start = (input_tokens = 100) => ({
	type: "message_start", message: {
		usage: { input_tokens, output_tokens: 1, cache_creation_input_tokens: 30, cache_read_input_tokens: 20 },
	},
})
const delta = (usage: Record<string, unknown>) => ({ type: "message_delta", usage })
const stream = (chunks: unknown[]) => ({ async *[Symbol.asyncIterator]() { yield* chunks } })
async function collect(chunks: AsyncIterable<ApiStreamChunk>) {
	const result: ApiStreamChunk[] = []
	for await (const chunk of chunks) result.push(chunk)
	return result
}

/** Real MiniMax conversion and Utility accounting; external SDK transport is controlled. */
describe("MiniMax cumulative usage", () => {
	afterEach(() => sinon.restore())

	function fixture(chunks: unknown[]) {
		const create = sinon.stub().resolves(stream(chunks))
		const handler = new MinimaxHandler({ minimaxApiKey: "test", disableRetries: true })
		sinon.stub(handler as any, "ensureClient").returns({ messages: { create } })
		return { handler, create }
	}

	it("retains omitted input/cache fields and yields detached cumulative snapshots", async () => {
		const { handler } = fixture([
			start(), delta({ output_tokens: 5 }), delta({ output_tokens: 9 }), delta({}),
			delta({ input_tokens: 120, output_tokens: 12, cache_read_input_tokens: 25 }),
		])
		const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))
		assert.deepEqual(chunks, [1, 5, 9, 9, 12].map((outputTokens, index) => ({
			type: "usage", inputTokens: index === 4 ? 120 : 100, outputTokens,
			cacheWriteTokens: 30, cacheReadTokens: index === 4 ? 25 : 20,
		})))
	})

	it("preserves explicitly reported zeroes while missing/null optional fields keep prior values", async () => {
		const { handler } = fixture([start(), delta({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: null })])
		const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))
		assert.deepEqual(chunks.at(-1), { type: "usage", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 20 })
	})

	for (const failed of [false, true]) {
		it(`Utility accounting retains observed totals through ${failed ? "a failed stream" : "completion and repeated snapshots"}`, async () => {
			const { handler, create } = fixture([])
			const failure = Object.assign(new Error("Authentication failed after billed usage"), { status: 401 })
			create.resolves({ async *[Symbol.asyncIterator]() {
				yield* [start(), delta({ output_tokens: 5 }), delta({ output_tokens: 9 }), delta({ output_tokens: 9 })]
				if (failed) throw failure
			} })
			const observed: ApiStreamUsageChunk[] = []
			const runner = new UtilityModelRunner({ provider: "minimax", modelId: handler.getModel().id }, () => handler, {
				onUsage: ({ usage }) => observed.push(usage),
			})
			const run = () => collect(runner.run({ systemPrompt: "system", messages: [{ role: "user", content: "hello" }] }))
			if (failed) await assert.rejects(run(), (error) => error === failure)
			else await run()
			assert.deepEqual(observed.reduce((total, usage) => ({
				input: total.input + usage.inputTokens, output: total.output + usage.outputTokens,
				cacheWrite: total.cacheWrite + (usage.cacheWriteTokens ?? 0), cacheRead: total.cacheRead + (usage.cacheReadTokens ?? 0),
			}), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }), { input: 100, output: 9, cacheWrite: 30, cacheRead: 20 })
			sinon.assert.calledOnce(create)
		})
	}

	it("resets usage for subsequent requests and keeps concurrent streams independent", async () => {
		const { handler, create } = fixture([])
		create.onFirstCall().resolves(stream([start(), delta({ output_tokens: 9 })]))
		create.onSecondCall().resolves(stream([start(7), delta({ output_tokens: 3 })]))
		const first = handler.createMessage("system", [{ role: "user", content: "one" }])[Symbol.asyncIterator]()
		const second = handler.createMessage("system", [{ role: "user", content: "two" }])[Symbol.asyncIterator]()
		await first.next()
		await second.next()
		assert.equal(((await first.next()).value as ApiStreamUsageChunk).inputTokens, 100)
		assert.equal(((await second.next()).value as ApiStreamUsageChunk).inputTokens, 7)
		await first.return?.(undefined)
		await second.return?.(undefined)
		create.resolves(stream([delta({ output_tokens: 4 })]))
		assert.deepEqual(await collect(handler.createMessage("system", [{ role: "user", content: "next" }])), [{ type: "usage", inputTokens: 0, outputTokens: 4 }])
	})
})
