import { describe, it } from "mocha"
import "should"
import type { ModelInfo } from "@shared/api"
import { TEST_MODEL_IDS } from "@test/fixtures/model-ids"
import sinon from "sinon"
import { createOpenRouterStream } from "../openrouter-stream"

describe("createOpenRouterStream", () => {
	const createAsyncIterable = () => ({
		async *[Symbol.asyncIterator]() {},
	})

	const createClient = () => {
		const create = sinon.stub().resolves(createAsyncIterable())
		return {
			client: {
				chat: {
					completions: {
						create,
					},
				},
			},
			create,
		}
	}

	const createModelInfo = (maxTokens: number, supportsPromptCache = false): ModelInfo => ({
		maxTokens,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache,
	})

	it("caps Gemini Flash OpenRouter requests to 32768 max_tokens", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "google/gemini-2.5-flash",
			info: createModelInfo(65_536),
		})

		const payload = create.firstCall.args[0] as Record<string, unknown>
		payload.should.have.property("max_tokens", 32_768)
	})

	it("keeps lower Gemini Flash max_tokens values when already below 32768", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "google/gemini-2.5-flash",
			info: createModelInfo(4_096),
		})

		const payload = create.firstCall.args[0] as Record<string, unknown>
		payload.should.have.property("max_tokens", 4_096)
	})

	it("caps non-Gemini models to 32768 max_tokens", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "anthropic/claude-sonnet-4.5",
			info: createModelInfo(64_000),
		})

		const payload = create.firstCall.args[0] as Record<string, unknown>
		payload.should.have.property("max_tokens", 32_768)
	})

	it("caps non-Flash Gemini models to 32768 max_tokens", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: TEST_MODEL_IDS.GEMINI_OPENROUTER,
			info: createModelInfo(65_536),
		})

		const payload = create.firstCall.args[0] as Record<string, unknown>
		payload.should.have.property("max_tokens", 32_768)
	})

	it("adds cache_control blocks when the model reports supportsPromptCache, regardless of id", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "deepseek/deepseek-chat",
			info: createModelInfo(65_536, true),
		})

		const payload = create.firstCall.args[0] as any
		payload.messages[0].content[0].cache_control.should.deepEqual({ type: "ephemeral" })
		payload.messages[1].content[0].cache_control.should.deepEqual({ type: "ephemeral" })
	})

	it("adds cache_control blocks for MiniMax models even without the flag", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "minimax/minimax-m2",
			info: createModelInfo(65_536, false),
		})

		const payload = create.firstCall.args[0] as any
		payload.messages[0].content[0].cache_control.should.deepEqual({ type: "ephemeral" })
	})

	it("does not add cache_control blocks for models without prompt cache support", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "google/gemini-2.5-pro",
			info: createModelInfo(65_536, false),
		})

		const payload = create.firstCall.args[0] as any
		payload.messages[0].content.should.be.a.String()
	})
})
