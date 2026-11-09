import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { convertDiracStorageToAnthropicMessage } from "../content"

describe("message content provenance cleanup", () => {
	for (const provider of ["anthropic", "openrouter"]) {
		for (const identity of ["taskletEventIds", "agentMessageIds", "journalNotificationIds"] as const) {
			it(`removes ${identity} without mutating persisted content for ${provider}`, () => {
				const message = { role: "user" as const, content: [{ type: "text" as const, text: "child update", [identity]: ["event-1"] }] }
				const result = convertDiracStorageToAnthropicMessage(message, provider)
				assert.equal(JSON.stringify(result).includes(identity), false)
				assert.match(JSON.stringify(result), /child update/)
				assert.deepEqual(message.content[0][identity], ["event-1"])
			})
		}
	}

	it("removes transient user-input provenance for ordinary providers", () => {
		const result = convertDiracStorageToAnthropicMessage({
			role: "user",
			content: [{ type: "text", text: "hello", isUserInput: true }],
		})
		const content = result.content as any[]

		assert.equal("isUserInput" in content[0], false)
		assert.equal(content[0].text, "hello")
	})

	it("removes provenance without discarding reasoning details for providers that preserve them", () => {
		const reasoningDetails = [
			{
				type: "reasoning.text",
				text: "reasoning",
				signature: "signature",
				format: "anthropic-claude-v1",
				index: 0,
			},
		]
		const result = convertDiracStorageToAnthropicMessage(
			{
				role: "user",
				content: [
					{ type: "text", text: "hello", isUserInput: true },
					{ type: "text", text: "preserve me", reasoning_details: reasoningDetails },
				],
			},
			"openrouter",
		)
		const content = result.content as any[]

		assert.equal("isUserInput" in content[0], false)
		assert.deepEqual(content[1].reasoning_details, reasoningDetails)
	})

	it("removes provenance recursively from tool results at the provider boundary", () => {
		const result = convertDiracStorageToAnthropicMessage(
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: [
							{
								type: "text",
								text: "machine text",
								isUserInput: true,
								steeringMessageIds: ["steer-1"],
								taskletEventIds: ["event-1"],
							},
						],
					},
				],
			} as any,
			"openrouter",
		)
		const nestedBlock = (result.content as any[])[0].content[0]

		assert.equal("isUserInput" in nestedBlock, false)
		assert.equal("steeringMessageIds" in nestedBlock, false)
		assert.equal("taskletEventIds" in nestedBlock, false)
	})

	it("removes provider-boundary metadata recursively from document content", () => {
		const result = convertDiracStorageToAnthropicMessage(
			{
				role: "user",
				content: [
					{
						type: "document",
						source: {
							type: "content",
							content: [
								{
									type: "text",
									text: "document text",
									isUserInput: true,
									steeringMessageIds: ["steer-1"],
									taskletEventIds: ["event-1"],
								},
							],
						},
					},
				],
			} as any,
			"openrouter",
		)
		const nestedBlock = (result.content as any[])[0].source.content[0]

		assert.equal("isUserInput" in nestedBlock, false)
		assert.equal("steeringMessageIds" in nestedBlock, false)
		assert.equal("taskletEventIds" in nestedBlock, false)
		assert.equal(nestedBlock.text, "document text")
	})
})
