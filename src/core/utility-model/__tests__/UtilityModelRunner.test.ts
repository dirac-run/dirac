import { strict as assert } from "node:assert"
import type { ApiHandler } from "@core/api"
import type { ApiStream, ApiStreamChunk } from "@core/api/transform/stream"
import type { ModelProviderSelection } from "@shared/api"
import type { DiracStorageMessage } from "@shared/messages/content"
import type { DiracTool } from "@shared/tools"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { ApiConfigurationError, ApiConfigurationErrorCode } from "@core/api/ApiConfigurationError"
import { UtilityModelCancelledError, UtilityModelRunner } from "../UtilityModelRunner"

const selection: ModelProviderSelection = {
	provider: "openai",
	modelId: "utility-model",
}

function streamChunks(chunks: ApiStreamChunk[]): ApiStream {
	return (async function* () {
		for (const chunk of chunks) yield chunk
	})()
}

function fakeHandler(createMessage: ApiHandler["createMessage"], abort?: () => void, modelId = "utility-model"): ApiHandler {
	return {
		createMessage,
		abort,
		getModel: () => ({ id: modelId, info: { supportsPromptCache: false } }),
	}
}

describe("UtilityModelRunner", () => {
	afterEach(() => sinon.restore())

	it("builds its independent handler lazily and forwards the exact request without executing tool calls", async () => {
		let handlerBuilds = 0
		const calls: Parameters<ApiHandler["createMessage"]>[] = []
		const tools = [{ name: "future-caller-tool" }] as unknown as DiracTool[]
		const messages = [] as DiracStorageMessage[]
		const toolCall: ApiStreamChunk = {
			type: "tool_calls",
			tool_call: { function: { name: "future-caller-tool", arguments: "{}" } },
		}
		const runner = new UtilityModelRunner(selection, () => {
			handlerBuilds++
			return fakeHandler((...args) => {
				calls.push(args)
				return streamChunks([{ type: "text", text: "result" }, { type: "reasoning", reasoning: "trace" }, toolCall])
			})
		})

		const stream = runner.run({ systemPrompt: "trusted prompt", messages, tools })
		assert.equal(handlerBuilds, 0)

		const chunks: ApiStreamChunk[] = []
		for await (const chunk of stream) chunks.push(chunk)

		assert.equal(handlerBuilds, 1)
		assert.equal(calls.length, 1)
		assert.equal(calls[0][0], "trusted prompt")
		assert.equal(calls[0][1], messages)
		assert.equal(calls[0][2], tools)
		assert.deepEqual(chunks, [{ type: "text", text: "result" }, { type: "reasoning", reasoning: "trace" }, toolCall])
	})

	it("publishes usage separately from the active API stream", async () => {
		const usages: number[] = []
		const runner = new UtilityModelRunner(
			selection,
			() =>
				fakeHandler(() =>
					streamChunks([
						{ type: "usage", inputTokens: 11, outputTokens: 7 },
						{ type: "text", text: "result" },
					]),
				),
			{ onUsage: ({ usage }) => usages.push(usage.totalCost ?? usage.inputTokens + usage.outputTokens) },
		)

		const chunks: ApiStreamChunk[] = []
		for await (const chunk of runner.run({ systemPrompt: "prompt", messages: [] })) chunks.push(chunk)

		assert.deepEqual(usages, [18])
		assert.equal(chunks[0].type, "usage")
	})

	it("publishes the model resolved by the handler after a successful request", async () => {
		const resolvedModels: string[] = []
		const runner = new UtilityModelRunner(
			selection,
			() => fakeHandler(() => streamChunks([{ type: "text", text: "result" }]), undefined, "resolved-utility-model"),
			{
				onModelResolved: ({ selection: resolvedSelection, modelId }) => {
					assert.equal(resolvedSelection, selection)
					resolvedModels.push(modelId)
				},
			},
		)

		for await (const _chunk of runner.run({ systemPrompt: "prompt", messages: [] })) {
			// Consume the complete request.
		}

		assert.deepEqual(resolvedModels, ["resolved-utility-model"])
	})

	it("does not construct a handler for a pre-aborted request", async () => {
		const controller = new AbortController()
		controller.abort()
		let handlerBuilds = 0
		const runner = new UtilityModelRunner(selection, () => {
			handlerBuilds++
			return fakeHandler(() => streamChunks([]))
		})

		await assert.rejects(
			async () => {
				for await (const _chunk of runner.run({ systemPrompt: "prompt", messages: [], signal: controller.signal })) {
					// The request must fail before producing a chunk.
				}
			},
			UtilityModelCancelledError,
		)
		assert.equal(handlerBuilds, 0)
	})

	it("aborts the handler and discards partial output when cancelled mid-stream", async () => {
		const controller = new AbortController()
		let aborts = 0
		let handlerBuilds = 0
		const runner = new UtilityModelRunner(selection, () => {
			handlerBuilds++
			return fakeHandler(async function* () {
				yield { type: "text", text: "partial" }
				controller.abort()
				yield { type: "text", text: "never accepted" }
			}, () => { aborts++ })
		})

		const stream = runner.run({ systemPrompt: "prompt", messages: [], signal: controller.signal })
		await assert.rejects(() => stream.next(), UtilityModelCancelledError)
		assert.equal(aborts, 1)
		assert.equal(handlerBuilds, 1)
	})

	it("retries provider failures three times with the normal backoff and surfaces the final error", async () => {
		let calls = 0
		let aborts = 0
		const providerFailure = new Error("provider failed")
		const retryEvents: number[] = []
		const runner = new UtilityModelRunner(selection, () => {
			calls++
			return fakeHandler(async function* () { throw providerFailure }, () => { aborts++ })
		}, { onRetry: ({ retryAttempt }) => { retryEvents.push(retryAttempt) } })
		const wait = sinon.stub(runner as any, "waitForRetry").resolves()

		await assert.rejects(() => runner.run({ systemPrompt: "prompt", messages: [] }).next(), providerFailure)
		assert.equal(calls, 4)
		assert.equal(aborts, 4)
		assert.deepEqual(retryEvents, [1, 2, 3])
		assert.deepEqual(wait.args.map(([delay]) => delay), [2000, 4000, 8000])
	})

	it("publishes only the successful attempt's output while accounting for usage from failed attempts", async () => {
		let calls = 0
		let aborts = 0
		const usages: number[] = []
		const resolvedModels: string[] = []
		const runner = new UtilityModelRunner(selection, () => {
			const attempt = ++calls
			return fakeHandler(async function* () {
				yield { type: "usage", inputTokens: attempt, outputTokens: 1 }
				if (attempt === 1) {
					yield { type: "text", text: "discard me" }
					yield { type: "tool_calls", tool_call: { function: { name: "discard-tool", arguments: "{}" } } }
					throw new Error("websocket failed after output")
				}
				yield { type: "text", text: "complete summary" }
			}, () => { aborts++ })
		}, {
			onUsage: ({ usage }) => usages.push(usage.inputTokens),
			onModelResolved: ({ modelId }) => resolvedModels.push(modelId),
		})
		sinon.stub(runner as any, "waitForRetry").resolves()
		const chunks: ApiStreamChunk[] = []
		for await (const chunk of runner.run({ systemPrompt: "prompt", messages: [] })) chunks.push(chunk)

		assert.equal(calls, 2)
		assert.equal(aborts, 1)
		assert.deepEqual(chunks, [
			{ type: "usage", inputTokens: 2, outputTokens: 1 },
			{ type: "text", text: "complete summary" },
		])
		assert.deepEqual(usages, [1, 2])
		assert.deepEqual(resolvedModels, ["utility-model"])
	})

	it("cancels during backoff without starting another attempt", async () => {
		const controller = new AbortController()
		let calls = 0
		const runner = new UtilityModelRunner(selection, () => {
			calls++
			return fakeHandler(async function* () { throw new Error("network failed") })
		}, {
			onRetry: () => { setTimeout(() => controller.abort(), 0) },
		})

		await assert.rejects(
			() => runner.run({ systemPrompt: "prompt", messages: [], signal: controller.signal }).next(),
			UtilityModelCancelledError,
		)
		assert.equal(calls, 1)
	})

	for (const status of [401, 402, 403]) {
		it(`does not retry authentication or payment errors (${status})`, async () => {
			let calls = 0
			const failure = Object.assign(new Error("access denied"), { status })
			const runner = new UtilityModelRunner(selection, () => {
				calls++
				return fakeHandler(async function* () { throw failure })
			})
			await assert.rejects(() => runner.run({ systemPrompt: "prompt", messages: [] }).next(), failure)
			assert.equal(calls, 1)
		})
	}

	it("does not retry a handler configuration failure", async () => {
		let calls = 0
		const failure = new ApiConfigurationError(ApiConfigurationErrorCode.ModelUnavailable, "Unknown model: luna")
		const runner = new UtilityModelRunner(selection, () => {
			calls++
			throw failure
		})
		await assert.rejects(() => runner.run({ systemPrompt: "prompt", messages: [] }).next(), failure)
		assert.equal(calls, 1)
	})
})
