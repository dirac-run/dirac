import "should"
import sinon from "sinon"
import { atlascloudDefaultModelId, atlascloudModels } from "@/shared/api"
import { Logger } from "@/shared/services/Logger"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { AtlasCloudHandler } from "../atlascloud"

const createAsyncIterable = (data: unknown[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

describe("AtlasCloudHandler", () => {
	afterEach(() => sinon.restore())

	const captureRequest = async (handler: AtlasCloudHandler, chunks: unknown[] = []) => {
		const create = sinon.stub().resolves(createAsyncIterable(chunks))
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		const yielded = []
		for await (const chunk of handler.createMessage("system prompt", [{ role: "user", content: "hi" }])) {
			yielded.push(chunk)
		}

		return { request: create.firstCall.args[0], yielded }
	}

	describe("getModel", () => {
		it("defaults to deepseek-v4-flash", () => {
			atlascloudDefaultModelId.should.equal("deepseek-ai/deepseek-v4-flash")
			const handler = new AtlasCloudHandler({ atlascloudApiKey: "test-key" })
			handler.getModel().id.should.equal("deepseek-ai/deepseek-v4-flash")
		})

		it("returns the requested model with its catalog entry", () => {
			const handler = new AtlasCloudHandler({ atlascloudApiKey: "test-key", apiModelId: "zai-org/glm-5.3" })
			const model = handler.getModel()
			model.id.should.equal("zai-org/glm-5.3")
			model.info.contextWindow!.should.equal(1048576)
			model.info.supportsTools!.should.equal(true)
		})

		it("logs an error and falls back to the default for an unknown model", () => {
			expectLoggerErrors()
			const loggerSpy = sinon.spy(Logger, "error")
			const handler = new AtlasCloudHandler({ atlascloudApiKey: "test-key", apiModelId: "non-existent-model" })

			handler.getModel().id.should.equal(atlascloudDefaultModelId)
			loggerSpy.calledOnce.should.be.true()
			loggerSpy.firstCall.args[0].should.match(/non-existent-model/)
		})
	})

	describe("ensureClient", () => {
		it("throws when no API key is configured", () => {
			const handler = new AtlasCloudHandler({})
			;(() => handler.getModel() && handler.createMessage("s", []).next()).should.not.throw()
			return handler
				.createMessage("s", [{ role: "user", content: "hi" }])
				.next()
				.should.be.rejectedWith(/Atlas Cloud API key is required/)
		})
	})

	describe("createMessage", () => {
		it("sends the system prompt as a system message and streams", async () => {
			const handler = new AtlasCloudHandler({ atlascloudApiKey: "test-key" })
			const { request } = await captureRequest(handler)

			request.model.should.equal(atlascloudDefaultModelId)
			request.stream.should.be.true()
			request.stream_options.should.deepEqual({ include_usage: true })
			request.messages[0].should.deepEqual({ role: "system", content: "system prompt" })
		})

		it("yields reasoning_content as reasoning and usage as usage", async () => {
			const handler = new AtlasCloudHandler({ atlascloudApiKey: "test-key" })
			const { yielded } = await captureRequest(handler, [
				{ choices: [{ delta: { reasoning_content: "thinking" } }] },
				{ choices: [{ delta: { content: "hello" } }] },
				{ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
			])

			yielded.should.deepEqual([
				{ type: "reasoning", reasoning: "thinking" },
				{ type: "text", text: "hello" },
				{ type: "usage", inputTokens: 7, outputTokens: 3 },
			])
		})
	})

	describe("catalog", () => {
		it("registers every model with tool support and a price", () => {
			Object.entries(atlascloudModels).should.not.be.empty()
			for (const [id, info] of Object.entries(atlascloudModels)) {
				info.supportsTools!.should.equal(true, `${id} must declare tool support`)
				info.inputPrice!.should.be.above(0, `${id} must carry an input price`)
				info.outputPrice!.should.be.above(0, `${id} must carry an output price`)
			}
		})
	})
})
