import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { bedrockModels, type ModelInfo } from "@shared/api"
import * as claudeCodeRunner from "@/integrations/claude-code/run"
import { AnthropicHandler } from "../anthropic"
import { AwsBedrockHandler } from "../bedrock"
import { ClaudeCodeHandler } from "../claude-code"
import { VertexHandler } from "../vertex"

async function drain(stream: AsyncIterable<unknown>) {
	for await (const _chunk of stream) { /* Consume the request. */ }
}

async function* emptyStream() { }

const tools = [{ name: "lookup", description: "Look up a value", input_schema: { type: "object" as const, properties: {} } }]
const cases = [
	{ id: "claude-sonnet-5-5", budget: undefined, effort: undefined, thinking: { type: "adaptive", display: "summarized" }, expectedEffort: "high" },
	{ id: "claude-sonnet-5-5", budget: 0, effort: "high", thinking: { type: "between_tools" }, expectedEffort: "high" },
	{ id: "claude-sonnet-5-5", budget: 0, effort: "xhigh", thinking: { type: "adaptive", display: "summarized" }, expectedEffort: "xhigh" },
	{ id: "claude-haiku-5-5", budget: undefined, effort: undefined, thinking: { type: "adaptive", display: "summarized" }, expectedEffort: "medium" },
	{ id: "claude-haiku-5-5", budget: 0, effort: "none", thinking: { type: "disabled" }, expectedEffort: "medium" },
	{ id: "claude-haiku-5-5", budget: 0, effort: "max", thinking: { type: "adaptive", display: "summarized" }, expectedEffort: "max" },
	{ id: "claude-fable-5-1", budget: 0, effort: "none", thinking: { type: "adaptive", display: "summarized" }, expectedEffort: "high" },
] as const

describe("current Claude provider compatibility", () => {
	afterEach(() => sinon.restore())

	for (const scenario of cases) {
		const title = `${scenario.id}, budget ${scenario.budget}, effort ${scenario.effort}`
		it(`sends supported Anthropic parameters for ${title}`, async () => {
			const handler = new AnthropicHandler({ apiKey: "key", apiModelId: scenario.id, thinkingBudgetTokens: scenario.budget, reasoningEffort: scenario.effort })
			const create = sinon.stub().resolves(emptyStream())
			sinon.stub(handler as any, "ensureClient").returns({ messages: { create } })
			const model = handler.getModel()
			sinon.stub(handler, "getModel").returns({ ...model, info: { ...model.info, temperature: 0.5 } })

			await drain(handler.createMessage("system", [{ role: "user", content: "hello" }], tools))

			const request = create.firstCall.args[0]
			expect(request.model).to.equal(scenario.id)
			expect(request.thinking).to.deep.equal(scenario.thinking)
			expect(request.output_config).to.deep.equal({ effort: scenario.expectedEffort })
			expect(request.temperature).to.equal(undefined)
			if (scenario.id !== "claude-haiku-5-5" || scenario.thinking.type !== "disabled") {
				expect(request.tool_choice).to.equal(undefined)
			}
		})

		it(`sends supported Vertex parameters for ${title}`, async () => {
			const handler = new VertexHandler({ vertexProjectId: "project", vertexRegion: "global", apiModelId: scenario.id, thinkingBudgetTokens: scenario.budget, reasoningEffort: scenario.effort })
			const create = sinon.stub().resolves(emptyStream())
			sinon.stub(handler as any, "ensureAnthropicClient").returns({ beta: { messages: { create } } })

			await drain(handler.createMessage("system", [{ role: "user", content: "hello" }], tools))

			const request = create.firstCall.args[0]
			expect(request.model).to.equal(scenario.id)
			expect(request.thinking).to.deep.equal(scenario.thinking)
			expect(request.output_config).to.deep.equal({ effort: scenario.expectedEffort })
			expect(request.temperature).to.equal(undefined)
		})

		it(`sends supported Bedrock Converse parameters for ${title}`, async () => {
			if (scenario.id === "claude-fable-5-1") return // Bedrock requires an unsupported explicit data-retention opt-in.
			const id = `anthropic.${scenario.id}` as keyof typeof bedrockModels
			const handler = new AwsBedrockHandler({ apiModelId: id, thinkingBudgetTokens: scenario.budget, reasoningEffort: scenario.effort })
			sinon.stub(handler as any, "prepareConverseInputs").returns({ messagesWithCache: [], systemMessages: [], toolConfig: { tools: [], toolChoice: { auto: {} } } })
			let request: any
			sinon.stub(handler as any, "executeConverseStream").callsFake(async function* (command: any) { request = command.input })

			await drain((handler as any).createAnthropicMessage({ modelId: `global.${id}`, model: { id, info: { ...bedrockModels[id], temperature: 0.5 } as ModelInfo }, systemPrompt: "system", messages: [] }))

			expect(request.modelId).to.equal(`global.${id}`)
			expect(request.additionalModelRequestFields.thinking).to.deep.equal(scenario.thinking)
			expect(request.additionalModelRequestFields.output_config).to.deep.equal({ effort: scenario.expectedEffort })
			expect(request.inferenceConfig.temperature).to.equal(undefined)
			expect(request.toolConfig.toolChoice).to.deep.equal({ auto: {} })
		})
	}

	it("uses the same Sonnet off mode on the uncached Anthropic path", async () => {
		const handler = new AnthropicHandler({ apiKey: "key", apiModelId: "claude-sonnet-5-5", thinkingBudgetTokens: 0 })
		const model = handler.getModel()
		sinon.stub(handler, "getModel").returns({ ...model, info: { ...model.info, supportsPromptCache: false } })
		const create = sinon.stub().resolves(emptyStream())
		sinon.stub(handler as any, "ensureClient").returns({ messages: { create } })

		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }], tools))

		expect(create.firstCall.args[0].thinking).to.deep.equal({ type: "between_tools" })
		expect(create.firstCall.args[0].tool_choice).to.deep.equal({ type: "auto" })
	})

	it("passes validated effort and the exact model ID to the Claude Code runner", async () => {
		const run = sinon.stub(claudeCodeRunner, "runClaudeCode").callsFake(emptyStream)
		const handler = new ClaudeCodeHandler({ apiModelId: "claude-sonnet-5-5", reasoningEffort: "none" })

		await drain(handler.createMessage("system", [{ role: "user", content: "hello" }]))

		expect(run.firstCall.args[0]).to.include({ modelId: "claude-sonnet-5-5", reasoningEffort: "medium" })
	})

	for (const provider of ["anthropic", "vertex"] as const) {
		function stubProvider(create: sinon.SinonStub) {
			if (provider === "anthropic") {
				const handler = new AnthropicHandler({ apiKey: "key", apiModelId: "claude-sonnet-5-5" })
				sinon.stub(handler as any, "ensureClient").returns({ messages: { create } })
				return handler
			}
			const handler = new VertexHandler({ vertexProjectId: "project", vertexRegion: "global", apiModelId: "claude-sonnet-5-5" })
			sinon.stub(handler as any, "ensureAnthropicClient").returns({ beta: { messages: { create } } })
			return handler
		}

		it(`repairs a prefix-bound thinking rejection once on ${provider} without changing saved history`, async () => {
			const messages: import("@anthropic-ai/sdk").Anthropic.MessageParam[] = [
				{ role: "user", content: "first" },
				{ role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: "rejected" }, { type: "text", text: "answer" }] },
				{ role: "user", content: "continue" },
			]
			const snapshots: unknown[] = []
			const mismatch = new Error("messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.")
			const create = sinon.stub().callsFake((request: any) => {
				snapshots.push(request.messages)
				return snapshots.length === 1 ? Promise.reject(mismatch) : Promise.resolve(emptyStream())
			})
			const handler = stubProvider(create)
			await drain(handler.createMessage("system", messages))
			await drain(handler.createMessage("system", messages))
			expect(create.callCount).to.equal(3)
			expect((snapshots[0] as any[])[1].content[0].type).to.equal("thinking")
			for (const requestMessages of snapshots.slice(1) as any[][]) {
				expect(requestMessages[1].content).to.have.length(1)
				expect(requestMessages[1].content[0]).to.include({ type: "text", text: "answer" })
			}
			expect((messages[1]!.content as any[])[0].type).to.equal("thinking")
		})

		it(`propagates signature corruption without retry on ${provider}`, async () => {
			const failure = new Error("messages.1.content.0: Invalid `signature` in `thinking` block.")
			const create = sinon.stub().rejects(failure)
			const handler = stubProvider(create)
			let caught: unknown
			try { await drain(handler.createMessage("system", [{ role: "user", content: "hello" }])) } catch (error) { caught = error }
			expect(caught).to.equal(failure)
			expect(create.callCount).to.equal(1)
		})

		it(`does not retry a prefix rejection after emitting output on ${provider}`, async () => {
			const failure = new Error("messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.")
			const create = sinon.stub().resolves((async function* () { yield {}; throw failure })())
			const handler = stubProvider(create)
			sinon.stub(handler as any, provider === "anthropic" ? "parseAnthropicChunk" : "parseVertexChunk").returns([{ type: "text", text: "started" }])
			const chunks: unknown[] = []
			let caught: unknown
			try { for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) chunks.push(chunk) } catch (error) { caught = error }
			expect(chunks).to.deep.equal([{ type: "text", text: "started" }])
			expect(caught).to.equal(failure)
			expect(create.callCount).to.equal(1)
		})
	}
})
