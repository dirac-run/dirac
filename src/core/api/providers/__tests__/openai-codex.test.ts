import "should"
import { expect } from "chai"
import sinon from "sinon"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { OpenAiCodexHandler } from "../openai-codex"
import { ApiConfigurationError, ApiConfigurationErrorCode } from "@core/api/ApiConfigurationError"
import { buildApiHandlerForSelection } from "@core/api"

const tools = [
	{
		type: "function",
		function: { name: "read_file", description: "", parameters: { type: "object" } },
	},
] as any

function currentCodexResponse(modelId = "gpt-5.6-terra", content: any = "previous answer", id = "resp_123") {
	return {
		role: "assistant",
		content,
		id,
		ts: Date.now(),
		modelInfo: { providerId: "openai-codex", modelId, mode: "act" },
	} as any
}

function createHandler(
	modelId = "gpt-5.6-terra",
	options: { disableRetries?: boolean; inferenceSpeed?: "default" | "standard" | "fast" } = {},
): OpenAiCodexHandler {
	return new OpenAiCodexHandler({ apiModelId: modelId, ...options })
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const chunks: unknown[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

describe("OpenAiCodexHandler persisted reasoning", () => {
	beforeEach(() => {
		sinon.stub(openAiCodexOAuthManager, "getAccessToken").resolves("test-access-token")
		sinon.stub(openAiCodexOAuthManager, "getAccountId").resolves(null)
	})

	afterEach(() => {
		sinon.restore()
	})

	it("uses the default only when no model was explicitly selected", () => {
		expect(new OpenAiCodexHandler({}).getModel().id).to.equal("gpt-6-astra")
		expect(createHandler("gpt-6-luna").getModel().id).to.equal("gpt-6-luna")
	})

	for (const modelId of ["luna", "", "toString"]) {
		it(`rejects the invalid explicit model ID ${JSON.stringify(modelId)} instead of selecting Astra`, () => {
			let error: unknown
			try {
				createHandler(modelId).getModel()
			} catch (caught) {
				error = caught
			}
			expect(error).to.be.instanceOf(ApiConfigurationError)
			expect((error as ApiConfigurationError).code).to.equal(ApiConfigurationErrorCode.ModelUnavailable)
			expect((error as Error).message).to.include(modelId)
		})
	}

	it("allows a Utility handler to recover a websocket transport failure through HTTP", async () => {
		expectLoggerErrors()
		const handler = buildApiHandlerForSelection({}, { provider: "openai-codex", modelId: "gpt-6-luna" })
		const websocket = sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* () {
			throw new Error("Responses websocket emitted an error event")
		})
		const http = sinon.stub(handler as any, "createResponseStreamHttp").callsFake(async function* (body: any) {
			expect(body.model).to.equal("gpt-6-luna")
			yield { type: "text", text: "summary" }
		})

		expect(await drain(handler.createMessage("system", [{ role: "user", content: "conversation" }]))).to.deep.equal([
			{ type: "text", text: "summary" },
		])
		expect(websocket.callCount).to.equal(1)
		expect(http.callCount).to.equal(1)
	})

	it("sends the priority tier for subscription Fast mode", async () => {
		const handler = createHandler("gpt-5.6-terra", { inferenceSpeed: "fast" })
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }] as any, tools))

		requests[0].service_tier.should.equal("priority")
	})

	it("uses GPT-6 Sol's default reasoning effort", async () => {
		const handler = createHandler("gpt-6-sol")
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }] as any, tools))

		requests[0].model.should.equal("gpt-6-sol")
		requests[0].reasoning.effort.should.equal("medium")
	})

	it("sends GPT-6.1 Sol with its supported default reasoning effort", async () => {
		const handler = createHandler("gpt-6.1-sol")
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }] as any, tools))

		requests[0].model.should.equal("gpt-6.1-sol")
		requests[0].reasoning.effort.should.equal("medium")
	})

	it("advertises provider-native web search support", () => {
		createHandler().supportsNativeWebSearch().should.equal(true)
	})

	it("attaches hosted web search only after activation and resets continuation", async () => {
		const handler = createHandler()
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_123" }
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "old question" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "old question" },
					currentCodexResponse(),
					{ role: "user", content: "search now" },
				] as any,
				tools,
				{ enableNativeWebSearch: true },
			),
		)

		requests[0].tools.some((tool: any) => tool.type === "web_search").should.equal(false)
		requests[1].tools.some((tool: any) => tool.type === "web_search").should.equal(true)
		expect(requests[1].previous_response_id).to.equal(undefined)
		requests[1].input.should.have.length(3)
	})

	it("uses full context until the active websocket session completes a response", async () => {
		const handler = createHandler()
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "new question" }] as any, tools))

		expect(requests[0].previous_response_id).to.equal(undefined)
		requests[0].input.should.have.length(1)
	})

	it("continues only from the immediately preceding response in the active websocket session", async () => {
		const handler = createHandler()
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_123" }
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "old question" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "old question" },
					currentCodexResponse(),
					{ role: "user", content: "new question" },
				] as any,
				tools,
			),
		)

		requests.should.have.length(2)
		requests[1].previous_response_id.should.equal("resp_123")
		requests[1].reasoning.context.should.equal("all_turns")
		requests[1].store.should.equal(false)
		requests[1].input.should.have.length(1)
	})

	it("does not chain when the websocket request configuration changes", async () => {
		const handler = createHandler()
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_123" }
		})

		await drain(handler.createMessage("system one", [{ role: "user", content: "old question" }] as any, tools))
		await drain(
			handler.createMessage(
				"system two",
				[
					{ role: "user", content: "old question" },
					currentCodexResponse(),
					{ role: "user", content: "new question" },
				] as any,
				tools,
			),
		)

		expect(requests[1].previous_response_id).to.equal(undefined)
		requests[1].input.should.have.length(3)
	})

	it("preserves Responses call IDs for persisted-reasoning tool results", async () => {
		const handler = createHandler()
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_123" }
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "read the file" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "read the file" },
					currentCodexResponse("gpt-5.6-terra", [
						{ type: "tool_use", id: "fc_local", call_id: "call_server", name: "read_file", input: {} },
					]),
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "fc_local", content: "contents" }] },
				] as any,
				tools,
			),
		)

		requests[1].input.should.deepEqual([{ type: "function_call_output", call_id: "call_server", output: "contents" }])
	})

	it("sends read-file images as structured incremental function output", async () => {
		const handler = createHandler()
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_123" }
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "read the image" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "read the image" },
					currentCodexResponse("gpt-5.6-terra", [
						{ type: "tool_use", id: "fc_local", call_id: "call_server", name: "read_file", input: {} },
					]),
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "fc_local",
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
				] as any,
				tools,
			),
		)

		requests[1].input.should.deepEqual([
			{
				type: "function_call_output",
				call_id: "call_server",
				output: [
					{ type: "input_text", text: "Successfully read image" },
					{
						type: "input_image",
						detail: "high",
						image_url: "data:image/png;base64,BASE64_SENTINEL",
					},
				],
			},
		])
		expect(typeof requests[1].input[0].output).not.to.equal("string")
	})

	it("retries an unavailable active websocket anchor with full context", async () => {
		const handler = createHandler()
		const requests: any[] = []
		const missingResponse = Object.assign(new Error("missing response"), { status: 404 })
		const websocketStub = sinon.stub(handler as any, "createResponseStreamWebsocket")
		websocketStub.onFirstCall().callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_123" }
		})
		websocketStub.onSecondCall().callsFake(async function* (request: any) {
			requests.push(request)
			throw missingResponse
		})
		websocketStub.onThirdCall().callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_456" }
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "old question" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "old question" },
					currentCodexResponse(),
					{ role: "user", content: "new question" },
				] as any,
				tools,
			),
		)

		requests[1].previous_response_id.should.equal("resp_123")
		expect(requests[2].previous_response_id).to.equal(undefined)
		requests[2].input.should.have.length(3)
	})

	it("clears continuation and reconnects with full context after a websocket fails after output", async () => {
		const handler = createHandler()
		const websocketFailure = new Error("401 Unauthorized after partial output")
		const websocketRequests: any[] = []
		const websocketStub = sinon.stub(handler as any, "createResponseStreamWebsocket")
		websocketStub.onFirstCall().callsFake(async function* (request: any) {
			websocketRequests.push(request)
			yield { type: "usage", id: "resp_123" }
		})
		websocketStub.onSecondCall().callsFake(async function* (request: any) {
			websocketRequests.push(request)
			yield { type: "text", text: "partial" }
			throw websocketFailure
		})
		websocketStub.onThirdCall().callsFake(async function* (request: any) {
			websocketRequests.push(request)
			yield { type: "usage", id: "resp_456" }
		})
		const httpStub = sinon.stub(handler as any, "createResponseStreamHttp").callsFake(async function* () {})
		const closeSpy = sinon.spy(handler as any, "closeResponsesWebsocket")
		const refreshStub = sinon.stub(openAiCodexOAuthManager, "forceRefreshAccessToken").resolves("refreshed-access-token")
		const messages = [{ role: "user", content: "first" }, currentCodexResponse(), { role: "user", content: "second" }] as any

		await drain(handler.createMessage("system", [{ role: "user", content: "first" }] as any, tools))
		let caughtError: unknown
		try {
			await drain(handler.createMessage("system", messages, tools))
		} catch (error) {
			caughtError = error
		}
		await drain(handler.createMessage("system", messages, tools))

		expect(caughtError).to.equal(websocketFailure)
		websocketRequests[1].previous_response_id.should.equal("resp_123")
		expect(websocketRequests[2].previous_response_id).to.equal(undefined)
		websocketRequests[2].input.should.have.length(3)
		httpStub.callCount.should.equal(0)
		closeSpy.callCount.should.equal(1)
		refreshStub.callCount.should.equal(0)
	})

	it("retries authentication with a fresh websocket and full context", async () => {
		expectLoggerErrors()
		const handler = createHandler()
		const unauthorized = new Error("401 Unauthorized")
		const websocketRequests: Array<{ request: any; accessToken: string }> = []
		const websocketStub = sinon.stub(handler as any, "createResponseStreamWebsocket")
		websocketStub.onFirstCall().callsFake(async function* (request: any, accessToken: string) {
			websocketRequests.push({ request, accessToken })
			yield { type: "usage", id: "resp_123" }
		})
		websocketStub.onSecondCall().callsFake(async function* (request: any, accessToken: string) {
			websocketRequests.push({ request, accessToken })
			throw unauthorized
		})
		websocketStub.onThirdCall().callsFake(async function* (request: any, accessToken: string) {
			websocketRequests.push({ request, accessToken })
			yield { type: "usage", id: "resp_456" }
		})
		const httpRequests: any[] = []
		sinon.stub(handler as any, "createResponseStreamHttp").callsFake(async function* (request: any) {
			httpRequests.push(request)
			throw unauthorized
		})
		const refreshStub = sinon.stub(openAiCodexOAuthManager, "forceRefreshAccessToken").resolves("refreshed-access-token")

		await drain(handler.createMessage("system", [{ role: "user", content: "first" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[{ role: "user", content: "first" }, currentCodexResponse(), { role: "user", content: "second" }] as any,
				tools,
			),
		)

		refreshStub.calledOnce.should.equal(true)
		websocketRequests[1].accessToken.should.equal("test-access-token")
		websocketRequests[1].request.previous_response_id.should.equal("resp_123")
		websocketRequests[2].accessToken.should.equal("refreshed-access-token")
		expect(websocketRequests[2].request.previous_response_id).to.equal(undefined)
		websocketRequests[2].request.input.should.have.length(3)
		httpRequests.should.have.length(1)
		expect(httpRequests[0].previous_response_id).to.equal(undefined)
	})

	it("does not retry authentication failures when retries are disabled", async () => {
		const handler = createHandler("gpt-5.6-terra", { disableRetries: true })
		const unauthorized = new Error("401 Unauthorized")
		const executeStub = sinon.stub(handler as any, "executeRequest").callsFake(async function* () {
			throw unauthorized
		})
		const refreshStub = sinon.stub(openAiCodexOAuthManager, "forceRefreshAccessToken")

		let caughtError: unknown
		try {
			await drain(handler.createMessage("system", [{ role: "user", content: "first" }] as any, tools))
		} catch (error) {
			caughtError = error
		}

		expect(caughtError).to.equal(unauthorized)
		executeStub.callCount.should.equal(1)
		refreshStub.callCount.should.equal(0)
	})

	it("does not retry or fall back after a websocket failure when retries are disabled", async () => {
		const handler = createHandler("gpt-5.6-terra", { disableRetries: true })
		const websocketFailure = new Error("websocket failed")
		const websocketStub = sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* () {
			throw websocketFailure
		})
		const httpStub = sinon.stub(handler as any, "createResponseStreamHttp").callsFake(async function* () {})

		let caughtError: unknown
		try {
			await drain(
				(handler as any).executeRequest(
					{},
					{},
					{},
					handler.getModel(),
					"test-access-token",
					true,
					"request-configuration",
				),
			)
		} catch (error) {
			caughtError = error
		}

		expect(caughtError).to.equal(websocketFailure)
		websocketStub.callCount.should.equal(1)
		httpStub.callCount.should.equal(0)
	})

	it("does not fall back from the HTTP SDK request when retries are disabled", async () => {
		const handler = createHandler("gpt-5.6-terra", { disableRetries: true })
		const sdkFailure = new Error("SDK request failed")
		const withResponse = sinon.stub().rejects(sdkFailure)
		;(handler as any).client = { responses: { create: sinon.stub().returns({ withResponse }) } }
		const manualRequestStub = sinon.stub(handler as any, "makeCodexRequest").callsFake(async function* () {})

		let caughtError: unknown
		try {
			await drain((handler as any).createResponseStreamHttp({}, handler.getModel(), "test-access-token", {}))
		} catch (error) {
			caughtError = error
		}

		expect(caughtError).to.equal(sdkFailure)
		withResponse.callCount.should.equal(1)
		manualRequestStub.callCount.should.equal(0)
	})

	it("does not start a manual HTTP request after SDK output was emitted", async () => {
		const handler = createHandler()
		const sdkFailure = new Error("SDK stream failed")
		async function* sdkStream() {
			yield { type: "response.output_text.delta", item_id: "message-1", delta: "partial" }
			throw sdkFailure
		}
		const withResponse = sinon.stub().resolves({ data: sdkStream(), response: { headers: new Headers() } })
		;(handler as any).client = { responses: { create: sinon.stub().returns({ withResponse }) } }
		const manualRequestStub = sinon.stub(handler as any, "makeCodexRequest").callsFake(async function* () {})
		const chunks: any[] = []
		let caughtError: unknown

		try {
			for await (const chunk of (handler as any).createResponseStreamHttp(
				{},
				handler.getModel(),
				"test-access-token",
				{},
			)) {
				chunks.push(chunk)
			}
		} catch (error) {
			caughtError = error
		}

		chunks.should.deepEqual([{ id: "message-1", type: "text", text: "partial" }])
		expect(caughtError).to.equal(sdkFailure)
		manualRequestStub.callCount.should.equal(0)
	})

	it("reconnects with full context after an HTTP fallback and resumes continuation", async () => {
		expectLoggerErrors()
		const handler = createHandler()
		const websocketFailure = new Error("Responses websocket closed before opening")
		const websocketRequests: any[] = []
		const websocketStub = sinon.stub(handler as any, "createResponseStreamWebsocket")
		websocketStub.onFirstCall().callsFake(async function* (request: any) {
			websocketRequests.push(request)
			throw websocketFailure
		})
		websocketStub.onSecondCall().callsFake(async function* (request: any) {
			websocketRequests.push(request)
			yield { type: "usage", id: "resp_456" }
		})
		websocketStub.onThirdCall().callsFake(async function* (request: any) {
			websocketRequests.push(request)
			yield { type: "usage", id: "resp_789" }
		})
		const httpRequests: any[] = []
		sinon.stub(handler as any, "createResponseStreamHttp").callsFake(async function* (request: any) {
			httpRequests.push(request)
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "first" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "first" },
					currentCodexResponse("gpt-5.6-terra", "first answer", "resp_http"),
					{ role: "user", content: "second" },
				] as any,
				tools,
			),
		)
		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "first" },
					currentCodexResponse("gpt-5.6-terra", "first answer", "resp_http"),
					{ role: "user", content: "second" },
					currentCodexResponse("gpt-5.6-terra", "second answer", "resp_456"),
					{ role: "user", content: "third" },
				] as any,
				tools,
			),
		)

		websocketStub.callCount.should.equal(3)
		httpRequests.should.have.length(1)
		expect(websocketRequests[1].previous_response_id).to.equal(undefined)
		websocketRequests[1].input.should.have.length(3)
		websocketRequests[2].previous_response_id.should.equal("resp_456")
		websocketRequests[2].input.should.have.length(1)
	})

	it("does not enable persisted reasoning for an unsupported Codex model", async () => {
		const handler = createHandler("gpt-5.5")
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamHttp").callsFake(async function* (request: any) {
			requests.push(request)
		})

		await drain(
			handler.createMessage(
				"system",
				[
					{ role: "user", content: "old question" },
					currentCodexResponse("gpt-5.5"),
					{ role: "user", content: "new question" },
				] as any,
				tools,
			),
		)

		expect(requests[0].previous_response_id).to.equal(undefined)
		expect(requests[0].reasoning?.context).to.equal(undefined)
		requests[0].input.should.have.length(3)
	})

	it("compacts the active Responses input into opaque replacement items", async () => {
		const handler = createHandler()
		const replacement = [
			{ role: "user", content: [{ type: "input_text", text: "retained" }] },
			{ id: "cmp_1", type: "compaction", encrypted_content: "opaque-state" },
		]
		const compact = sinon.stub().returns({
			withResponse: sinon.stub().resolves({ data: { output: replacement }, response: { headers: new Headers() } }),
		})
		sinon.stub(handler as any, "createCodexClient").returns({ responses: { compact } })

		const result = await handler.compactConversation({
			systemPrompt: "system",
			messages: [{ role: "user", content: "question" }] as any,
			tools,
		})

		result.input.should.deepEqual(replacement)
		const body = compact.firstCall.args[0]
		expect(body.previous_response_id).to.equal(undefined)
		expect(body.stream).to.equal(undefined)
		body.reasoning.context.should.equal("all_turns")
		body.tools.some((tool: any) => tool.type === "web_search").should.equal(false)
	})

	it("does not retry compact authentication failures when retries are disabled", async () => {
		const handler = createHandler("gpt-5.6-terra", { disableRetries: true })
		const unauthorized = new Error("401 Unauthorized")
		const compact = sinon.stub().returns({ withResponse: sinon.stub().rejects(unauthorized) })
		sinon.stub(handler as any, "createCodexClient").returns({ responses: { compact } })
		const refreshStub = sinon.stub(openAiCodexOAuthManager, "forceRefreshAccessToken")

		let caughtError: unknown
		try {
			await handler.compactConversation({
				systemPrompt: "system",
				messages: [{ role: "user", content: "question" }] as any,
				tools,
			})
		} catch (error) {
			caughtError = error
		}

		expect(caughtError).to.equal(unauthorized)
		compact.callCount.should.equal(1)
		refreshStub.callCount.should.equal(0)
	})

	it("starts a compacted branch without the stale anchor and then resumes from the new response", async () => {
		const handler = createHandler()
		const requests: any[] = []
		const websocketStub = sinon.stub(handler as any, "createResponseStreamWebsocket")
		websocketStub.onFirstCall().callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_old" }
		})
		websocketStub.onSecondCall().callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: "resp_new" }
		})
		websocketStub.onThirdCall().callsFake(async function* (request: any) {
			requests.push(request)
		})
		const checkpoint = {
			providerId: "openai-codex",
			modelId: "gpt-5.6-terra",
			compactedThroughHistoryIndex: 2,
			input: [
				{ role: "user", content: [{ type: "input_text", text: "retained" }] },
				{ id: "cmp_1", type: "compaction", encrypted_content: "opaque-state" },
			],
		}

		await drain(handler.createMessage("system", [{ role: "user", content: "old" }] as any, tools))
		await drain(handler.createMessage("system", [], tools, { checkpoint, breakProviderContinuation: true }))
		await drain(
			handler.createMessage(
				"system",
				[currentCodexResponse("gpt-5.6-terra", "new answer", "resp_new"), { role: "user", content: "next" }] as any,
				tools,
				{ checkpoint },
			),
		)

		expect(requests[1].previous_response_id).to.equal(undefined)
		requests[1].input.should.deepEqual(checkpoint.input)
		requests[2].previous_response_id.should.equal("resp_new")
		requests[2].input.should.have.length(1)
	})

	it("breaks stale continuation when remote compaction falls back to local truncation", async () => {
		const handler = createHandler()
		const requests: any[] = []
		sinon.stub(handler as any, "createResponseStreamWebsocket").callsFake(async function* (request: any) {
			requests.push(request)
			yield { type: "usage", id: requests.length === 1 ? "resp_old" : "resp_new" }
		})

		await drain(handler.createMessage("system", [{ role: "user", content: "old" }] as any, tools))
		await drain(
			handler.createMessage(
				"system",
				[currentCodexResponse("gpt-5.6-terra", "summary", "resp_old"), { role: "user", content: "continue" }] as any,
				tools,
				{ breakProviderContinuation: true },
			),
		)

		expect(requests[1].previous_response_id).to.equal(undefined)
		requests[1].input.should.have.length(2)
	})
})
