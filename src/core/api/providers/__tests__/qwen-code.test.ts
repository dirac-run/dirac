import { strict as assert } from "node:assert"
import sinon from "sinon"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import { qwenCodeDefaultModelId, qwenCodeModels } from "@shared/api"
import type { DiracStorageMessage } from "@/shared/messages/content"
import { fetch, mockFetchForTesting } from "@/shared/net"
import { getQwenCachedCredentialPath } from "@/utils/qwenCodeCredentialPath"
import { QwenCodeHandler } from "../qwen-code"
import * as catalog from "../qwen-code-models"
import type { ApiStreamChunk } from "../../transform/stream"
import { QwenSubscriptionSession } from "../qwen-subscription-session"

const userMessages: DiracStorageMessage[] = [{ role: "user", content: "hi" }]
const textDelta = (content: string) => ({ choices: [{ delta: { content } }] })
const sseBody = (chunks: unknown[]) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
const streamResponse = (chunks: unknown[] = []) =>
	new Response(sseBody(chunks), { headers: { "content-type": "text/event-stream" } })
const apiError = (status: number) =>
	new Response(JSON.stringify({ error: { message: `HTTP ${status}` } }), {
		status,
		headers: { "content-type": "application/json" },
	})
const collect = async (handler: QwenCodeHandler, messages = userMessages, tools?: ChatCompletionTool[]) => {
	const chunks = []
	for await (const chunk of handler.createMessage("system", messages, tools)) chunks.push(chunk)
	return chunks
}

describe("QwenCodeHandler subscription streaming", () => {
	let tokens: sinon.SinonStub
	let models: sinon.SinonStub

	beforeEach(() => {
		tokens = sinon.stub(QwenSubscriptionSession.prototype, "accessToken").resolves("initial-token")
		models = sinon.stub(catalog, "getCachedQwenCodeModels").returns({ ...qwenCodeModels })
	})
	afterEach(() => sinon.restore())

	it("uses the fixed gateway, an immutable request token, honest Dirac UA and no redirects", async () => {
		const requests: Request[] = []
		await mockFetchForTesting(
			async (input, init) => {
				requests.push(new Request(input, init))
				return streamResponse([textDelta("hello")])
			},
			async () => {
				assert.deepEqual(await collect(new QwenCodeHandler({ qwenCodeOauthPath: "/synthetic/subscription.json" })), [
					{ type: "text", text: "hello" },
				])
			},
		)
		assert.equal(requests.length, 1)
		const request = requests[0]
		assert.equal(request.url, "https://api.qwen.ai/compatible-mode/v1/chat/completions")
		assert.equal(request.headers.get("authorization"), "Bearer initial-token")
		assert.match(request.headers.get("user-agent")!, /^Dirac\//)
		assert.doesNotMatch(request.headers.get("user-agent")!, /QwenCode|Qwen-Code/i)
		assert.equal(request.redirect, "error")
		assert.deepEqual(tokens.firstCall.args, [])
		assert.equal(models.firstCall.args[0], "/synthetic/subscription.json")
	})

	it("does not inherit unrelated OpenAI organization/project environment headers", async () => {
		const previousOrg = process.env.OPENAI_ORG_ID
		const previousProject = process.env.OPENAI_PROJECT_ID
		process.env.OPENAI_ORG_ID = "unrelated-organization"
		process.env.OPENAI_PROJECT_ID = "unrelated-project"
		try {
			await mockFetchForTesting(
				async (_input, init) => {
					const headers = new Headers(init?.headers)
					assert.equal(headers.has("openai-organization"), false)
					assert.equal(headers.has("openai-project"), false)
					return streamResponse()
				},
				() => collect(new QwenCodeHandler({})),
			)
		} finally {
			if (previousOrg === undefined) delete process.env.OPENAI_ORG_ID
			else process.env.OPENAI_ORG_ID = previousOrg
			if (previousProject === undefined) delete process.env.OPENAI_PROJECT_ID
			else process.env.OPENAI_PROJECT_ID = previousProject
		}
	})

	it("refreshes a rejected token once and resends the same body", async () => {
		tokens.onFirstCall().resolves("old-token")
		tokens.onSecondCall().resolves("new-token")
		const requests: Request[] = []
		await mockFetchForTesting(
			async (input, init) => {
				requests.push(new Request(input, init))
				return requests.length === 1 ? apiError(401) : streamResponse([textDelta("ok")])
			},
			async () => {
				assert.deepEqual(await collect(new QwenCodeHandler({})), [{ type: "text", text: "ok" }])
			},
		)
		assert.deepEqual(tokens.args, [[], ["old-token"]])
		assert.deepEqual(
			requests.map((request) => request.headers.get("authorization")),
			["Bearer old-token", "Bearer new-token"],
		)
		assert.deepEqual(await requests[0].json(), await requests[1].json())
	})

	it("does not refresh a 401 when retries are disabled", async () => {
		let calls = 0
		await mockFetchForTesting(
			async () => {
				calls++
				return apiError(401)
			},
			async () => {
				await assert.rejects(collect(new QwenCodeHandler({ disableRetries: true })), (error: any) => error.status === 401)
			},
		)
		assert.equal(calls, 1)
		assert.equal(tokens.callCount, 1)
	})

	it("does not refresh a second 401", async () => {
		let calls = 0
		await mockFetchForTesting(
			async () => {
				calls++
				return apiError(401)
			},
			async () => {
				await assert.rejects(collect(new QwenCodeHandler({})), (error: any) => error.status === 401)
			},
		)
		assert.equal(calls, 2)
		assert.equal(tokens.callCount, 2)
	})

	for (const status of [403, 404, 429, 500]) {
		it(`does not refresh or implicitly retry HTTP ${status}`, async () => {
			let calls = 0
			await mockFetchForTesting(
				async () => {
					calls++
					return apiError(status)
				},
				async () => {
					await assert.rejects(collect(new QwenCodeHandler({})), (error: any) => error.status === status)
				},
			)
			assert.equal(calls, 1)
			assert.equal(tokens.callCount, 1)
		})
	}

	it("propagates authentication failure without sending inference", async () => {
		const failure = new Error("Sign in with Qwen Code")
		tokens.rejects(failure)
		await mockFetchForTesting(
			async () => {
				throw new Error("must not fetch")
			},
			async () => {
				await assert.rejects(collect(new QwenCodeHandler({})), (error) => error === failure)
			},
		)
	})

	it("does not replay output or refresh after a delivered stream fails", async () => {
		let requests = 0
		const delivered: ApiStreamChunk[] = []
		const encoder = new TextEncoder()
		let reads = 0
		await mockFetchForTesting(
			async () => {
				requests++
				return new Response(
					new ReadableStream({
						pull(controller) {
							if (reads++ === 0)
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(textDelta("partial"))}\n\n`))
							else controller.error(Object.assign(new Error("stream failed"), { status: 401 }))
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				)
			},
			async () => {
				await assert.rejects(async () => {
					for await (const chunk of new QwenCodeHandler({}).createMessage("system", userMessages)) delivered.push(chunk)
				}, /stream failed/)
			},
		)
		assert.deepEqual(delivered, [{ type: "text", text: "partial" }])
		assert.equal(requests, 1)
		assert.equal(tokens.callCount, 1)
	})

	it("keeps concurrent request authorization independent", async () => {
		tokens.onFirstCall().resolves("request-a")
		tokens.onSecondCall().resolves("request-b")
		const authorization: string[] = []
		await mockFetchForTesting(
			async (_input, init) => {
				authorization.push(new Headers(init?.headers).get("authorization")!)
				await Promise.resolve()
				return streamResponse()
			},
			async () => {
				const handler = new QwenCodeHandler({})
				await Promise.all([collect(handler), collect(handler)])
			},
		)
		assert.deepEqual(authorization.sort(), ["Bearer request-a", "Bearer request-b"])
	})

	for (const status of [200, 403, 405]) {
		it(`reports HTTP ${status} HTML without exposing its body or claiming WAF causation`, async () => {
			await mockFetchForTesting(
				async () =>
					new Response("<html>secret-gateway-body</html>", {
						status,
						headers: { "content-type": "text/html" },
					}),
				async () => {
					await assert.rejects(collect(new QwenCodeHandler({})), (error: any) => {
						assert.match(error.message, /Qwen Subscription gateway/)
						assert.match(error.message, new RegExp(`HTTP ${status}`))
						assert.match(error.message, /Qwen-supported client access/)
						assert.doesNotMatch(error.message, /secret-gateway-body|<html>|WAF/)
						return true
					})
				},
			)
		})
	}

	it("preserves repeated/prefix-overlapping deltas and literal think tags", async () => {
		const deltas = ["Hello", "Hello", "Hello world", "<thi", "nk>literal", "</think>"]
		await mockFetchForTesting(
			async () => streamResponse(deltas.map(textDelta)),
			async () => {
				assert.deepEqual(
					await collect(new QwenCodeHandler({})),
					deltas.map((text) => ({ type: "text", text })),
				)
			},
		)
	})

	it("emits structured reasoning, ordinary text and usage-only final events", async () => {
		await mockFetchForTesting(
			async () =>
				streamResponse([
					{ choices: [{ delta: { reasoning_content: "thinking", content: "answer" } }] },
					{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
					{ usage: {} },
				]),
			async () => {
				assert.deepEqual(await collect(new QwenCodeHandler({})), [
					{ type: "reasoning", reasoning: "thinking" },
					{ type: "text", text: "answer" },
					{ type: "usage", inputTokens: 10, outputTokens: 5 },
					{ type: "usage", inputTokens: 0, outputTokens: 0 },
				])
			},
		)
	})

	it("preserves interleaved tool IDs, names and argument fragments", async () => {
		await mockFetchForTesting(
			async () =>
				streamResponse([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_a",
											type: "function",
											function: { name: "weather", arguments: '{"city":' },
										},
										{
											index: 1,
											id: "call_b",
											type: "function",
											function: { name: "time", arguments: '{"zone":' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{ index: 1, function: { arguments: '"UTC"}' } },
										{ index: 0, function: { arguments: '"SF"}' } },
									],
								},
							},
						],
					},
				]),
			async () => {
				const chunks = await collect(new QwenCodeHandler({}))
				assert.deepEqual(
					chunks.map((chunk: any) => [
						chunk.tool_call.call_id,
						chunk.tool_call.function.name,
						chunk.tool_call.function.arguments,
					]),
					[
						["call_a", "weather", '{"city":'],
						["call_b", "time", '{"zone":'],
						["call_b", "time", '"UTC"}'],
						["call_a", "weather", '"SF"}'],
					],
				)
			},
		)
	})

	it("serializes tool history with matching call IDs and no cache_control", async () => {
		const messages: DiracStorageMessage[] = [
			{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "weather", input: { city: "SF" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }] },
		]
		const tools: ChatCompletionTool[] = [
			{ type: "function", function: { name: "weather", parameters: { type: "object", properties: {} } } },
		]
		await mockFetchForTesting(
			async (input, init) => {
				const body = await new Request(input, init).json()
				assert.equal(body.messages[1].tool_calls[0].id, "call_1")
				assert.equal(body.messages[2].tool_call_id, "call_1")
				assert.equal(body.messages[2].content, "sunny")
				assert.deepEqual(body.tools, tools)
				assert.equal(body.parallel_tool_calls, true)
				assert.doesNotMatch(JSON.stringify(body), /cache_control/)
				return streamResponse()
			},
			() => collect(new QwenCodeHandler({ enableParallelToolCalling: true }), messages, tools),
		)
	})

	for (const [effort, budget] of [
		[undefined, 16384],
		["low", 4096],
		["medium", 16384],
		["high", 32768],
		["xhigh", 32768],
		["max", 32768],
	] as const) {
		it(`sends top-level thinking parameters for ${effort ?? "default medium"}`, async () => {
			await mockFetchForTesting(
				async (input, init) => {
					const body = await new Request(input, init).json()
					assert.equal(body.enable_thinking, true)
					assert.equal(body.thinking_budget, budget)
					assert.equal(body.stream, true)
					assert.deepEqual(body.stream_options, { include_usage: true })
					for (const key of [
						"reasoning_effort",
						"reasoning",
						"chat_template_kwargs",
						"max_completion_tokens",
						"max_tokens",
						"temperature",
					])
						assert.equal(key in body, false)
					return streamResponse()
				},
				() => collect(new QwenCodeHandler({ reasoningEffort: effort })),
			)
		})
	}

	for (const options of [
		{ reasoningEffort: "none" },
		{ reasoningEffort: "off", thinkingBudgetTokens: 1234 },
		{ thinkingBudgetTokens: 0 },
	]) {
		it(`omits thinking budget when disabled: ${JSON.stringify(options)}`, async () => {
			await mockFetchForTesting(
				async (input, init) => {
					const body = await new Request(input, init).json()
					assert.equal(body.enable_thinking, false)
					assert.equal("thinking_budget" in body, false)
					return streamResponse()
				},
				() => collect(new QwenCodeHandler(options)),
			)
		})
	}

	it("lets an explicit effort override the host's zero-budget default", async () => {
		await mockFetchForTesting(
			async (input, init) => {
				const body = await new Request(input, init).json()
				assert.equal(body.enable_thinking, true)
				assert.equal(body.thinking_budget, 4096)
				return streamResponse()
			},
			() => collect(new QwenCodeHandler({ reasoningEffort: "low", thinkingBudgetTokens: 0 })),
		)
	})

	it("honors an explicit native budget", async () => {
		await mockFetchForTesting(
			async (input, init) => {
				const body = await new Request(input, init).json()
				assert.equal(body.enable_thinking, true)
				assert.equal(body.thinking_budget, 2345)
				return streamResponse()
			},
			() => collect(new QwenCodeHandler({ reasoningEffort: "high", thinkingBudgetTokens: 2345 })),
		)
	})

	it("respects mandatory-thinking metadata", async () => {
		models.returns({ mandatory: { supportsPromptCache: false, thinkingAlwaysOn: true } })
		await mockFetchForTesting(
			async (input, init) => {
				const body = await new Request(input, init).json()
				assert.equal(body.enable_thinking, true)
				assert.equal(body.thinking_budget, 16384)
				return streamResponse()
			},
			() => collect(new QwenCodeHandler({ apiModelId: "mandatory", reasoningEffort: "none" })),
		)
	})

	it("returns no output for empty streams/deltas", async () => {
		await mockFetchForTesting(
			async () => streamResponse([{ choices: [] }, { choices: [{ delta: { content: "", reasoning_content: "" } }] }]),
			async () => {
				assert.deepEqual(await collect(new QwenCodeHandler({})), [])
			},
		)
	})

	it("defaults to the first account model and migrates only absent retired IDs", () => {
		models.returns({ "account-first": { supportsImages: true }, "account-next": { supportsPromptCache: false } })
		assert.equal(new QwenCodeHandler({}).getModel().id, "account-first")
		assert.equal(new QwenCodeHandler({ apiModelId: "qwen3-coder-plus" }).getModel().id, "account-first")
		assert.equal(new QwenCodeHandler({ apiModelId: "qwen3-coder-flash" }).getModel().id, "account-first")
		assert.deepEqual(new QwenCodeHandler({ apiModelId: "custom-model" }).getModel(), {
			id: "custom-model",
			info: { supportsPromptCache: false },
		})
		models.returns({ "qwen3-coder-plus": { supportsImages: false } })
		assert.equal(new QwenCodeHandler({ apiModelId: "qwen3-coder-plus" }).getModel().id, "qwen3-coder-plus")
	})

	it("does not mistake inherited object keys for model metadata", () => {
		for (const id of ["constructor", "toString", "__proto__"]) {
			assert.deepEqual(new QwenCodeHandler({ apiModelId: id }).getModel(), { id, info: { supportsPromptCache: false } })
		}
	})

	it("uses the bundled fallback default when no account catalog exists", () => {
		assert.equal(new QwenCodeHandler({}).getModel().id, qwenCodeDefaultModelId)
	})

	it("passes the resolved credential path and proxy-aware transport to the session", () => {
		const handler = new QwenCodeHandler({ qwenCodeOauthPath: "./synthetic-credentials.json" })
		// Inspect only synthetic constructor inputs, never any real credential file.
		assert.equal((handler as any).session.filePath, getQwenCachedCredentialPath("./synthetic-credentials.json"))
		assert.equal((handler as any).session.request, fetch)
	})
})
