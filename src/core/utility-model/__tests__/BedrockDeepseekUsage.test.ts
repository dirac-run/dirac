import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { AwsBedrockHandler } from "@core/api/providers/bedrock"
import type { ApiStreamChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import { calculateApiCostOpenAI } from "@utils/cost"
import { UtilityModelRunner } from "../UtilityModelRunner"

/** Real provider conversion and Utility accounting; only the external AWS client is controlled. */
describe("Bedrock DeepSeek cumulative usage", () => {
	afterEach(() => sinon.restore())

	for (const format of ["choices", "delta"] as const) {
		for (const failed of [false, true]) {
			it(`retains cumulative ${format} usage through ${failed ? "failure before final snapshot" : "completion"}`, async () => {
				const handler = new AwsBedrockHandler({ apiModelId: "deepseek.r1-v1:0", disableRetries: true })
				sinon.stub(handler, "getModel").returns({ id: "deepseek.r1-v1:0", info: { supportsPromptCache: false, inputPrice: 1, outputPrice: 2 } })
				const text = "x".repeat(400)
				const chunks = [text, text, "tail"]
				const failure = Object.assign(new Error("Authentication failed after billed output"), { status: 401 })
				const destroy = sinon.stub()
				const send = sinon.stub().resolves({
					body: {
						async *[Symbol.asyncIterator]() {
							for (const part of failed ? chunks.slice(0, 2) : chunks) {
								const response = format === "choices" ? { choices: [{ text: part }] } : { delta: { text: part } }
								yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(response)) } }
							}
							if (failed) throw failure
						},
					},
				})
				sinon.stub(handler as unknown as { getBedrockClient(): Promise<unknown> }, "getBedrockClient").resolves({ send, destroy })
				const observed: ApiStreamUsageChunk[] = []
				const runner = new UtilityModelRunner(
					{ provider: "bedrock", modelId: "deepseek.r1-v1:0" }, () => handler,
					{ onUsage: ({ usage }) => observed.push(usage) },
				)
				const output: ApiStreamChunk[] = []
				const run = async () => {
					for await (const chunk of runner.run({ systemPrompt: "system", messages: [{ role: "user", content: "question" }] })) output.push(chunk)
				}
				if (failed) await assert.rejects(run(), (error) => error === failure)
				else await run()

				assert.ok(observed[0].inputTokens > 0)
				assert.deepEqual(observed.map((usage) => usage.outputTokens), failed ? [0, 100, 100] : [0, 100, 100, 1, 0])
				assert.deepEqual(observed.map((usage) => usage.inputTokens), failed ? [observed[0].inputTokens, 0, 0] : [observed[0].inputTokens, 0, 0, 0, 0])
				const expectedOutput = failed ? 200 : 201
				const cost = observed.reduce((total, usage) => total + (usage.totalCost ?? 0), 0)
				const expectedCost = calculateApiCostOpenAI(handler.getModel().info, observed[0].inputTokens, expectedOutput, 0, 0)
				assert.ok(expectedCost !== undefined)
				assert.ok(Math.abs(cost - expectedCost) < 1e-12)
				if (failed) assert.deepEqual(output, [], "Failed attempts must not publish provisional text")
				else {
					assert.equal(output.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text).join(""), chunks.join(""))
					const usage = output.filter((chunk) => chunk.type === "usage")
					assert.deepEqual(usage.map((chunk) => chunk.inputTokens), Array(5).fill(observed[0].inputTokens))
					assert.deepEqual(usage.map((chunk) => chunk.outputTokens), [0, 100, 200, 201, 201])
				}
				sinon.assert.calledOnce(send)
				sinon.assert.calledOnce(destroy)
			})
		}
	}
})
