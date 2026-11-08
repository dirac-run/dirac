import "should"
import assert from "node:assert/strict"
import { mockFetchForTesting } from "@/shared/net"
import { expect } from "chai"
import sinon from "sinon"
import { OpenAiHandler } from "../openai"

describe("OpenAiHandler cancellation", () => {
	afterEach(() => {
		sinon.restore()
	})

	it("aborts an in-flight Chat Completions request", async () => {
		let requestSignal: AbortSignal | undefined
		const createStub = sinon.stub().callsFake((_body: unknown, options: { signal: AbortSignal }) => {
			requestSignal = options.signal
			return new Promise((_resolve, reject) => {
				options.signal.addEventListener(
					"abort",
					() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					{ once: true },
				)
			})
		})
		const handler = new OpenAiHandler({
			openAiApiKey: "test-key",
			openAiModelId: "test-model",
			openAiModelInfo: { supportsPromptCache: false, supportsTools: true },
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create: createStub } } })

		const nextPromise = handler
			.createMessage("system", [{ role: "user", content: "hello" }])
		[Symbol.asyncIterator]()
			.next()
		await new Promise<void>((resolve) => setImmediate(resolve))
		if (!requestSignal) throw new Error("OpenAI request did not start")

		requestSignal.aborted.should.equal(false)
		handler.abort()
		requestSignal.aborted.should.equal(true)

		let caught: unknown
		try {
			await nextPromise
		} catch (error) {
			caught = error
		}
		expect(caught).to.be.instanceOf(Error)
		expect((handler as any).abortController).to.equal(undefined)
	})

	it("does not start another request when aborted during retry backoff", async () => {
		const clock = sinon.useFakeTimers()
		let notifyRetryStarted!: () => void
		const retryStarted = new Promise<void>((resolve) => {
			notifyRetryStarted = resolve
		})
		const createStub = sinon.stub().rejects(Object.assign(new Error("rate limited"), { status: 429 }))
		const handler = new OpenAiHandler({
			openAiApiKey: "test-key",
			openAiModelId: "test-model",
			openAiModelInfo: { supportsPromptCache: false, supportsTools: true },
			onRetryAttempt: () => notifyRetryStarted(),
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create: createStub } } })

		const pendingChunk = handler.createMessage("system", [{ role: "user", content: "hello" }]).next()
		const rejectedChunk = pendingChunk.should.be.rejected()
		await retryStarted

		handler.abort()
		await clock.tickAsync(1_000)
		await rejectedChunk

		sinon.assert.calledOnce(createStub)
	})
})
describe("OpenAiHandler explicit compatible endpoints", () => {
	const ambientKeys = ["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"] as const
	let previousEnvironment: (string | undefined)[]

	beforeEach(() => {
		previousEnvironment = ambientKeys.map((key) => process.env[key])
		for (const key of ambientKeys) process.env[key] = `ambient-${key}`
	})

	afterEach(() => {
		ambientKeys.forEach((key, index) => {
			const previous = previousEnvironment[index]
			if (previous === undefined) delete process.env[key]
			else process.env[key] = previous
		})
	})

	async function consume(handler: OpenAiHandler) {
		const chunks = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) chunks.push(chunk)
		return chunks
	}

	function completionResponse() {
		return new Response('data: {"choices":[{"delta":{"content":"local reply"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', {
			headers: { "Content-Type": "text/event-stream" },
		})
	}

	it("sends a real SDK keyless request with the custom model and no ambient credentials", async () => {
		const requests: Request[] = []
		await mockFetchForTesting(async (input, init) => {
			const request = new Request(input, init)
			requests.push(request)
			assert.equal(request.url, "http://localhost:1234/v1/chat/completions")
			assert.equal(request.headers.get("authorization"), null)
			assert.equal(request.headers.get("openai-organization"), null)
			assert.equal(request.headers.get("openai-project"), null)
			assert.equal(request.headers.get("x-local-setting"), "explicit")
			assert.equal((await request.json()).model, "local/custom-model")
			return completionResponse()
		}, async () => {
			const handler = new OpenAiHandler({
				openAiBaseUrl: " http://localhost:1234/v1/chat/completions/ ",
				openAiModelId: "local/custom-model", openAiHeaders: { "X-Local-Setting": "explicit" }, disableRetries: true,
			})
			const chunks = await consume(handler)
			assert.ok(chunks.some((chunk) => chunk.type === "text" && chunk.text === "local reply"))
			assert.equal(handler.getModel().id, "local/custom-model")
		})
		assert.equal(requests.length, 1)
	})

	it("does not reuse an authenticated endpoint's key or headers for a keyless endpoint", async () => {
		const requests: Request[] = []
		await mockFetchForTesting(async (input, init) => {
			requests.push(new Request(input, init))
			return completionResponse()
		}, async () => {
			await consume(new OpenAiHandler({
				openAiBaseUrl: "https://authenticated.example/v1", openAiApiKey: "explicit-secret",
				openAiHeaders: { "X-Endpoint-Secret": "endpoint-secret" }, openAiModelId: "remote/model", disableRetries: true,
			}))
			await consume(new OpenAiHandler({
				openAiBaseUrl: "http://localhost:1234/v1", openAiModelId: "local/model", disableRetries: true,
			}))
		})
		assert.equal(requests.length, 2)
		assert.equal(requests[0].headers.get("authorization"), "Bearer explicit-secret")
		assert.equal(requests[0].headers.get("x-endpoint-secret"), "endpoint-secret")
		assert.equal(requests[1].headers.get("authorization"), null)
		assert.equal(requests[1].headers.get("x-endpoint-secret"), null)
	})

	it("surfaces a rejected custom model without retrying a fallback model", async () => {
		const models: string[] = []
		const handler = new OpenAiHandler({
			openAiBaseUrl: "http://localhost:1234/v1", openAiModelId: "local/missing-model", disableRetries: true,
		})
		await mockFetchForTesting(async (input, init) => {
			models.push((await new Request(input, init).json()).model)
			return new Response(JSON.stringify({ error: { message: "Unknown local/missing-model", type: "invalid_request_error", code: "model_not_found" } }), {
				status: 404, headers: { "Content-Type": "application/json" },
			})
		}, async () => {
			await assert.rejects(consume(handler), /Unknown local\/missing-model/)
		})
		assert.deepEqual(models, ["local/missing-model"])
		assert.equal(handler.getModel().id, "local/missing-model")
	})

	it("still requires credentials for implicit OpenAI, official OpenAI, and Azure endpoints", async () => {
		for (const options of [
			{}, { openAiBaseUrl: "   " }, { openAiBaseUrl: "https://api.openai.com/v1" },
			{ openAiBaseUrl: "https://example.openai.azure.com/", openAiModelId: "deepseek-model" },
			{ openAiBaseUrl: "http://localhost:1234", azureApiVersion: "2024-02-01" },
		]) {
			await assert.rejects(consume(new OpenAiHandler({ ...options, disableRetries: true })), /API key or Azure Identity Authentication is required/)
		}
	})
})
