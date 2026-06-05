import type * as acp from "@agentclientprotocol/sdk"
import { DiracMessageType, CardStatus } from "@shared/ExtensionMessage"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it } from "vitest"
import { translateMessage, translateMessages } from "./messageTranslator"
import type { AcpSessionState } from "./public-types"
import { AcpSessionStatus } from "./public-types"

function createMarkdownMessage(content: string, isReasoning = false): DiracMessage {
	return {
		id: "msg-id",
		ts: Date.now(),
		content: {
			type: DiracMessageType.MARKDOWN,
			content,
			isReasoning,
		},
	} as DiracMessage
}

function createCardMessage(card: any): DiracMessage {
	return {
		id: "msg-id",
		ts: Date.now(),
		content: {
			type: DiracMessageType.CARD,
			card,
		},
	} as DiracMessage
}

function createApiStatusMessage(status: string): DiracMessage {
	return {
		id: "msg-id",
		ts: Date.now(),
		content: {
			type: DiracMessageType.API_STATUS,
			status,
		},
	} as DiracMessage
}

function createTestSessionState(): AcpSessionState {
	return {
		sessionId: "test-session-id",
		status: AcpSessionStatus.Idle,
		pendingToolCalls: new Map(),
	}
}

describe("messageTranslator (Modular Architecture)", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	describe("translateMessage - Markdown", () => {
		it("should translate regular markdown to agent_message_chunk", () => {
			const message = createMarkdownMessage("Hello world")
			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			expect(result.updates[0].sessionUpdate).toBe("agent_message_chunk")
			expect((result.updates[0] as any).content.text).toBe("Hello world")
		})

		it("should translate reasoning markdown to agent_thought_chunk", () => {
			const message = createMarkdownMessage("Thinking...", true)
			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			expect(result.updates[0].sessionUpdate).toBe("agent_thought_chunk")
			expect((result.updates[0] as any).content.text).toBe("Thinking...")
		})

		it("should not generate update for empty markdown content", () => {
			const message = createMarkdownMessage("")
			const result = translateMessage(message, sessionState)
			expect(result.updates).toHaveLength(0)
		})
	})

	describe("translateMessage - Card", () => {
		it("should translate a new Card to tool_call", () => {
			const card = {
				id: "tool-1",
				header: "read_file",
				status: CardStatus.RUNNING,
				body: "Reading file.txt",
			}
			const message = createCardMessage(card)
			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			expect(result.updates[0].sessionUpdate).toBe("tool_call")
			const toolCall = result.updates[0] as acp.ToolCall
			expect(toolCall.toolCallId).toBe("tool-1")
			expect(toolCall.title).toBe("read_file")
			expect(toolCall.status).toBe("in_progress")
			expect(sessionState.pendingToolCalls.has("tool-1")).toBe(true)
		})

		it("should translate an existing Card update to tool_call_update", () => {
			const card1 = {
				id: "tool-1",
				header: "read_file",
				status: CardStatus.RUNNING,
			}
			translateMessage(createCardMessage(card1), sessionState)

			const card2 = {
				id: "tool-1",
				header: "read_file",
				status: CardStatus.SUCCESS,
				body: "File content",
			}
			const message = createCardMessage(card2)
			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			expect(result.updates[0].sessionUpdate).toBe("tool_call_update")
			const update = result.updates[0] as acp.ToolCallUpdate
			expect(update.toolCallId).toBe("tool-1")
			expect(update.status).toBe("completed")
		})

		it("should handle interaction requests (approvals)", () => {
			const card = {
				id: "tool-1",
				header: "execute_command",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
			}
			const message = createCardMessage(card)
			const result = translateMessage(message, sessionState)

			expect(result.requiresPermission).toBe(true)
			expect(result.permissionRequest).toBeDefined()
			expect(result.permissionRequest?.options).toHaveLength(2)
			expect(result.permissionRequest?.options?.[0].name).toBe("Approve")
			expect(result.permissionRequest?.options?.[1].name).toBe("Reject")
		})

		it("should handle interaction requests (feedback/input)", () => {
			const card = {
				id: "tool-1",
				header: "ask_followup_question",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: false,
			}
			const message = createCardMessage(card)
			const result = translateMessage(message, sessionState)

			expect(result.requiresPermission).toBe(true)
			expect(result.permissionRequest).toBeDefined()
			expect(result.permissionRequest?.options).toHaveLength(1)
			expect(result.permissionRequest?.options?.[0].name).toBe("Submit")
		})

		it("should map CardStatus.ERROR to failed", () => {
			const card = {
				id: "tool-1",
				header: "read_file",
				status: CardStatus.ERROR,
				body: "File not found",
			}
			const result = translateMessage(createCardMessage(card), sessionState)
			const update = result.updates[0] as acp.ToolCall
			expect(update.status).toBe("failed")
		})

		it("should map CardStatus.CANCELLED to failed", () => {
			const card = {
				id: "tool-1",
				header: "read_file",
				status: CardStatus.CANCELLED,
			}
			const result = translateMessage(createCardMessage(card), sessionState)
			const update = result.updates[0] as acp.ToolCall
			expect(update.status).toBe("failed")
		})

		it("should clear pendingToolCalls when card reaches final status", () => {
			const cardId = "tool-1"
			translateMessage(createCardMessage({ id: cardId, header: "h", status: CardStatus.RUNNING }), sessionState)
			expect(sessionState.pendingToolCalls.has(cardId)).toBe(true)

			translateMessage(createCardMessage({ id: cardId, header: "h", status: CardStatus.SUCCESS }), sessionState)
			expect(sessionState.pendingToolCalls.has(cardId)).toBe(false)
		})
	})

	describe("translateMessage - API Status", () => {
		it("should skip API_STATUS messages", () => {
			const message = createApiStatusMessage("started")
			const result = translateMessage(message, sessionState)
			expect(result.updates).toHaveLength(0)
		})
	})

	describe("translateMessages", () => {
		it("should translate multiple messages", () => {
			const messages = [
				createMarkdownMessage("Step 1"),
				createCardMessage({ id: "t1", header: "h1", status: CardStatus.SUCCESS }),
			]
			const updates = translateMessages(messages, sessionState)
			expect(updates).toHaveLength(2)
			expect(updates[0].sessionUpdate).toBe("agent_message_chunk")
			expect(updates[1].sessionUpdate).toBe("tool_call")
		})
	})
})
