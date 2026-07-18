import "should"
import sinon from "sinon"
import { moonshotDefaultModelId, moonshotModels } from "@/shared/api"
import { MoonshotHandler } from "../moonshot"

const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

describe("MoonshotHandler", () => {
	afterEach(() => sinon.restore())

	const captureRequest = async (handler: MoonshotHandler) => {
		const create = sinon.stub().resolves(createAsyncIterable())
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } } as any)

		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			// Consume the stream so the request is issued.
		}

		return create.firstCall.args[0]
	}

	it("uses kimi-k3 as the default model with its published metadata", () => {
		moonshotDefaultModelId.should.equal("kimi-k3")
		moonshotModels["kimi-k3"].should.deepEqual({
			maxTokens: 131_072,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsReasoning: true,
			supportsTools: true,
			supportsPromptCache: true,
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheReadsPrice: 0.3,
			isR1FormatRequired: true,
		})
	})

	it("uses K3's fixed reasoning and completion parameters without sampling parameters", async () => {
		const request = await captureRequest(new MoonshotHandler({ moonshotApiKey: "test-api-key" }))

		request.model.should.equal("kimi-k3")
		request.max_completion_tokens.should.equal(131_072)
		request.reasoning_effort.should.equal("max")
		request.should.not.have.property("max_tokens")
		request.should.not.have.property("temperature")
		request.should.not.have.property("top_p")
		request.should.not.have.property("n")
		request.should.not.have.property("presence_penalty")
		request.should.not.have.property("frequency_penalty")
	})

	it("keeps the existing request parameters for older Moonshot models", async () => {
		const request = await captureRequest(
			new MoonshotHandler({ moonshotApiKey: "test-api-key", apiModelId: "kimi-k2.6" }),
		)

		request.model.should.equal("kimi-k2.6")
		request.max_tokens.should.equal(32_000)
		request.temperature.should.equal(1.0)
		request.should.not.have.property("max_completion_tokens")
		request.should.not.have.property("reasoning_effort")
	})
})
