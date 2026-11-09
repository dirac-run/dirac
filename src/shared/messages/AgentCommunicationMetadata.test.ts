import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { cleanContentBlock, removeProviderBoundaryMetadataFromMessage, type DiracStorageMessage } from "./content"

describe("Agent mail provider metadata", () => {
	it("strips inclusion identities at provider boundaries, including nested tool results", () => {
		const block = { type: "text" as const, text: "attributed agent mail", agentMessageIds: ["mail-1"] }
		const nested = { type: "tool_result" as const, tool_use_id: "call-1", content: [block] }
		const message: DiracStorageMessage = { role: "user", content: [block, nested] }
		assert.deepEqual(removeProviderBoundaryMetadataFromMessage(message).content, [
			{ type: "text", text: block.text },
			{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: block.text }] },
		])
		assert.deepEqual(cleanContentBlock(block), { type: "text", text: block.text })
		assert.doesNotMatch(JSON.stringify(cleanContentBlock(nested)), /agentMessageIds|mail-1/)
		assert.deepEqual(block.agentMessageIds, ["mail-1"], "Canonical inclusion identity is retained")
	})
})
