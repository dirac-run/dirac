import "should"
import sinon from "sinon"
import { nebiusDefaultModelId } from "@/shared/api"
import { Logger } from "@/shared/services/Logger"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { NebiusHandler } from "../nebius"

const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

describe("NebiusHandler", () => {
	afterEach(() => sinon.restore())

	const captureRequest = async (handler: NebiusHandler, messages: any[] = [{ role: "user", content: "hi" }]) => {
		const create = sinon.stub().resolves(createAsyncIterable())
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } } as any)

		for await (const _chunk of handler.createMessage("system prompt", messages)) {
			// Consume stream
		}

		return create.firstCall.args[0]
	}

	describe("getModel & Catalog", () => {
		it("uses openai/gpt-oss-120b as default", () => {
			nebiusDefaultModelId.should.equal("openai/gpt-oss-120b")
			const handler = new NebiusHandler({ nebiusApiKey: "test-key" })
			const model = handler.getModel()
			model.id.should.equal("openai/gpt-oss-120b")
		})

		it("returns registered GLM models with correct capabilities", () => {
			const handler = new NebiusHandler({ nebiusApiKey: "test-key", apiModelId: "zai-org/GLM-5.3-Flash" })
			const model = handler.getModel()
			model.id.should.equal("zai-org/GLM-5.3-Flash")
			model.info.supportsImages!.should.equal(false) // Overridden text-only on Nebius
			model.info.supportsTools!.should.equal(true)
		})

		it("returns registered Kimi models with isR1FormatRequired", () => {
			const handlerK26 = new NebiusHandler({ nebiusApiKey: "test-key", apiModelId: "moonshotai/Kimi-K2.6" })
			const modelK26 = handlerK26.getModel()
			modelK26.id.should.equal("moonshotai/Kimi-K2.6")
			;(modelK26.info as any).isR1FormatRequired.should.equal(true)

			const handlerK3 = new NebiusHandler({ nebiusApiKey: "test-key", apiModelId: "moonshotai/Kimi-K3" })
			const modelK3 = handlerK3.getModel()
			modelK3.id.should.equal("moonshotai/Kimi-K3")
			;(modelK3.info as any).isR1FormatRequired.should.equal(true)
		})

		it("logs an error and falls back to default when unknown model is requested", () => {
			expectLoggerErrors()
			const loggerSpy = sinon.spy(Logger, "error")
			const handler = new NebiusHandler({ nebiusApiKey: "test-key", apiModelId: "non-existent-model" })
			const model = handler.getModel()

			model.id.should.equal(nebiusDefaultModelId)
			sinon.assert.calledOnce(loggerSpy)
			sinon.assert.calledWithMatch(loggerSpy, sinon.match(/Unknown Nebius model 'non-existent-model'/))
		})
	})

	describe("Message formatting & Multi-turn Tool Calls", () => {
		it("applies addReasoningContent for Kimi models on multi-turn messages with reasoning", async () => {
			const handler = new NebiusHandler({
				nebiusApiKey: "test-key",
				apiModelId: "moonshotai/Kimi-K2.6",
			})

			const multiTurnMessages = [
				{ role: "user" as const, content: "Initial prompt" },
				{
					role: "assistant" as const,
					content: [
						{ type: "thinking" as const, thinking: "Let me check the tools" },
						{ type: "tool_use" as const, id: "tool-1", name: "list_files", input: {} },
					],
				},
				{
					role: "user" as const,
					content: [{ type: "tool_result" as const, tool_use_id: "tool-1", content: "file1.ts" }],
				},
			]

			const request = await captureRequest(handler, multiTurnMessages)
			request.model.should.equal("moonshotai/Kimi-K2.6")

			// Assistant message must contain reasoning_content for Kimi models
			const assistantMsg = request.messages.find((m: any) => m.role === "assistant")
			assistantMsg.should.have.property("reasoning_content", "Let me check the tools")
		})

		it("does not apply R1 reasoning_content for GLM models", async () => {
			const handler = new NebiusHandler({
				nebiusApiKey: "test-key",
				apiModelId: "zai-org/GLM-5.3-Flash",
			})

			const messages = [
				{ role: "user" as const, content: "Hello" },
				{
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "Hi there!" }],
				},
			]

			const request = await captureRequest(handler, messages)
			request.model.should.equal("zai-org/GLM-5.3-Flash")
			const assistantMsg = request.messages.find((m: any) => m.role === "assistant")
			assistantMsg.should.not.have.property("reasoning_content")
		})
	})
})
