import { Anthropic } from "@anthropic-ai/sdk"
import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { expect } from "chai"
import { ContextManager } from "../ContextManager"

// Minimal mock for ApiHandler — only getModel().info.contextWindow is used by shouldCompactContextWindow
function createMockApi(contextWindow: number) {
	return {
		getModel: () => ({ id: "test-model", info: { contextWindow } }),
	} as any
}

function createApiReqMessage(tokens: {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
}): DiracMessage {
	return {
		id: "test-id-" + Math.random(),
		ts: Date.now(),
		content: {
			type: DiracMessageType.API_STATUS,
			status: tokens,
		},
	}
}

describe("ContextManager", () => {
	function createMessages(count: number): Anthropic.Messages.MessageParam[] {
		const messages: Anthropic.Messages.MessageParam[] = []

		messages.push({
			role: "user",
			content: "Initial task message",
		})

		let role: "user" | "assistant" = "assistant"
		for (let i = 1; i < count; i++) {
			messages.push({
				role,
				content: `Message ${i}`,
			})
			role = role === "user" ? "assistant" : "user"
		}

		return messages
	}

	describe("getNextTruncationRange", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("first truncation with half keep", () => {
			const messages = createMessages(11)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			expect(result).to.deep.equal([2, 5])
		})

		it("first truncation with quarter keep", () => {
			const messages = createMessages(11)
			const result = contextManager.getNextTruncationRange(messages, undefined, "quarter")

			expect(result).to.deep.equal([2, 7])
		})

		it("sequential truncation with half keep", () => {
			const messages = createMessages(21)
			const firstRange = contextManager.getNextTruncationRange(messages, undefined, "half")
			expect(firstRange).to.deep.equal([2, 9])

			// Pass the previous range for sequential truncation
			const secondRange = contextManager.getNextTruncationRange(messages, firstRange, "half")
			expect(secondRange).to.deep.equal([2, 13])
		})

		it("sequential truncation with quarter keep", () => {
			const messages = createMessages(41)
			const firstRange = contextManager.getNextTruncationRange(messages, undefined, "quarter")

			const secondRange = contextManager.getNextTruncationRange(messages, firstRange, "quarter")

			expect(secondRange[0]).to.equal(2)
			expect(secondRange[1]).to.be.greaterThan(firstRange[1])
		})

		it("ensures the last message in range is a user message", () => {
			const messages = createMessages(14)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			// Check if the message at the end of range is an assistant message
			const lastRemovedMessage = messages[result[1]]
			expect(lastRemovedMessage.role).to.equal("assistant")

			// Check if the next message after the range is a user message
			const nextMessage = messages[result[1] + 1]
			expect(nextMessage.role).to.equal("user")
		})

		it("handles small message arrays", () => {
			const messages = createMessages(3)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			expect(result).to.deep.equal([2, 1])
		})

		it("preserves the message structure when truncating", () => {
			const messages = createMessages(20)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			// Get messages after removing the range
			const effectiveMessages = [...messages.slice(0, result[0]), ...messages.slice(result[1] + 1)]

			// Check first message and alternating pattern
			expect(effectiveMessages[0].role).to.equal("user")
			for (let i = 1; i < effectiveMessages.length; i++) {
				const expectedRole = i % 2 === 1 ? "assistant" : "user"
				expect(effectiveMessages[i].role).to.equal(expectedRole)
			}
		})
	})


	describe("getTruncatedMessages", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("returns original messages when no range is provided", () => {
			const messages = createMessages(3)

			const result = contextManager.getTruncatedMessages(messages, undefined)
			expect(result).to.deep.equal(messages)
		})

		it("correctly removes messages in the specified range", () => {
			const messages = createMessages(5)

			const range: [number, number] = [1, 3]
			const result = contextManager.getTruncatedMessages(messages, range)

			expect(result).to.have.lengthOf(3)
			expect(result[0]).to.deep.equal(messages[0])
			expect(result[1]).to.deep.equal(messages[1])
			expect(result[2]).to.deep.equal(messages[4])
		})

		it("works with a range that starts at the first message after task", () => {
			const messages = createMessages(4)

			const range: [number, number] = [1, 2]
			const result = contextManager.getTruncatedMessages(messages, range)

			expect(result).to.have.lengthOf(3)
			expect(result[0]).to.deep.equal(messages[0])
			expect(result[1]).to.deep.equal(messages[1])
			expect(result[2]).to.deep.equal(messages[3])
		})

		it("correctly handles removing a range while preserving alternation pattern", () => {
			const messages = createMessages(5)

			const range: [number, number] = [2, 3]
			const result = contextManager.getTruncatedMessages(messages, range)

			expect(result).to.have.lengthOf(3)
			expect(result[0]).to.deep.equal(messages[0])
			expect(result[1]).to.deep.equal(messages[1])
			expect(result[2]).to.deep.equal(messages[4])

			expect(result[0].role).to.equal("user")
			expect(result[1].role).to.equal("assistant")
			expect(result[2].role).to.equal("user")
		})

		it("removes orphaned tool_results after truncation", () => {
			// Create messages with tool_use and tool_result blocks
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Response 1" },
				// Assistant message with tool_use that will be truncated
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Using a tool" },
						{ type: "tool_use", id: "tool_123", name: "read_file", input: { path: "test.ts" } },
					],
				},
				// User message with tool_result - should have tool_result removed after truncation
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tool_123", content: "file content here" },
						{ type: "text", text: "Additional user text" },
					],
				},
				{ role: "assistant", content: "Response 2" },
			]

			// Truncate to remove the assistant message with tool_use
			const range: [number, number] = [2, 2]
			const result = contextManager.getTruncatedMessages(messages, range)

			// Should have 4 messages (original 5 minus 1 truncated)
			expect(result).to.have.lengthOf(4)

			// The user message at index 2 should have tool_result removed but text preserved
			const userMessageAfterTruncation = result[2]
			expect(userMessageAfterTruncation.role).to.equal("user")
			expect(Array.isArray(userMessageAfterTruncation.content)).to.be.true

			const content = userMessageAfterTruncation.content as Anthropic.Messages.ContentBlockParam[]
			// Should only have the text block, not the tool_result
			expect(content).to.have.lengthOf(1)
			expect(content[0].type).to.equal("text")
			expect((content[0] as Anthropic.Messages.TextBlockParam).text).to.equal("Additional user text")
		})
	})

	describe("shouldCompactContextWindow", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("does not compact at 33K tokens with default 0.75 threshold on 200K context", () => {
			const api = createMockApi(200_000)
			const diracMessages: DiracMessage[] = [createApiReqMessage({ tokensIn: 30_000, tokensOut: 3_000 })]

			const result = contextManager.shouldCompactContextWindow(diracMessages, api, 0, 0.75)
			expect(result).to.equal(false)
		})

		it("compacts when tokens exceed 0.75 threshold on 200K context", () => {
			const api = createMockApi(200_000)
			const diracMessages: DiracMessage[] = [createApiReqMessage({ tokensIn: 140_000, tokensOut: 15_000 })]

			const result = contextManager.shouldCompactContextWindow(diracMessages, api, 0, 0.75)
			expect(result).to.equal(true)
		})

		it("compacts at only 10K tokens when threshold is accidentally set to 0.05", () => {
			const contextWindow = 200_000
			const accidentalThreshold = 0.05
			// floor(200000 * 0.05) = 10000 — this is the bug case from PR #9348.
			// Accidental clicks on the progress bar set threshold to ~5%, triggering
			// compaction at 10K tokens instead of the intended 150K (0.75 * 200K).
			const compactionTriggersAt = Math.floor(contextWindow * accidentalThreshold) // 10,000
			const totalTokens = compactionTriggersAt + 500 // 10,500 — just above the trigger

			const api = createMockApi(contextWindow)
			const tokensIn = totalTokens - 1_500
			const tokensOut = 1_500
			const diracMessages: DiracMessage[] = [createApiReqMessage({ tokensIn, tokensOut })]

			const result = contextManager.shouldCompactContextWindow(diracMessages, api, 0, accidentalThreshold)
			expect(result).to.equal(true)
		})

		it("falls back to maxAllowedSize when threshold is undefined", () => {
			const api = createMockApi(200_000)
			// 155K tokens — above 0.75 threshold (150K) but below maxAllowedSize (160K)
			const diracMessages: DiracMessage[] = [createApiReqMessage({ tokensIn: 150_000, tokensOut: 5_000 })]

			const result = contextManager.shouldCompactContextWindow(diracMessages, api, 0, undefined)
			// undefined → uses maxAllowedSize (160K), so 155K < 160K → false
			expect(result).to.equal(false)
		})

		it("falls back to maxAllowedSize when threshold is 0", () => {
			const api = createMockApi(200_000)
			const diracMessages: DiracMessage[] = [createApiReqMessage({ tokensIn: 150_000, tokensOut: 5_000 })]

			// 0 is falsy, so ternary falls back to maxAllowedSize (160K)
			const result = contextManager.shouldCompactContextWindow(diracMessages, api, 0, 0)
			expect(result).to.equal(false)
		})

		it("includes cacheWrites and cacheReads in total token count", () => {
			const api = createMockApi(200_000)
			// Low direct tokens but high cache reads push total over threshold
			const diracMessages: DiracMessage[] = [
				createApiReqMessage({ tokensIn: 5_000, tokensOut: 500, cacheWrites: 0, cacheReads: 150_000 }),
			]

			const result = contextManager.shouldCompactContextWindow(diracMessages, api, 0, 0.75)
			expect(result).to.equal(true)
		})

		it("returns false when previousApiReqIndex is negative", () => {
			const api = createMockApi(200_000)
			const diracMessages: DiracMessage[] = [createApiReqMessage({ tokensIn: 200_000 })]

			const result = contextManager.shouldCompactContextWindow(diracMessages, api, -1, 0.75)
			expect(result).to.equal(false)
		})

		it("threshold is capped at maxAllowedSize even when percentage is very high", () => {
			const api = createMockApi(200_000)
			// threshold of 1.0 → floor(200000 * 1.0) = 200000, but min(200000, 160000) = 160000
			const diracMessages: DiracMessage[] = [createApiReqMessage({ tokensIn: 165_000 })]

			const result = contextManager.shouldCompactContextWindow(diracMessages, api, 0, 1.0)
			expect(result).to.equal(true)
		})
	})
})
