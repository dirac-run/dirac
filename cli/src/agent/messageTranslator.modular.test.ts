import type * as acp from "@agentclientprotocol/sdk"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { CardKind, CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { ResponseOperation, responseCardInput } from "@shared/responseTool"
import { beforeEach, describe, expect, it } from "vitest"
import { translateMessage, translateMessages } from "./messageTranslator"
import { handlePermissionResponse } from "./permissionHandler"
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

function createCheckpointMessage(): DiracMessage {
	return {
		id: "checkpoint-id",
		ts: Date.now(),
		content: {
			type: DiracMessageType.CHECKPOINT,
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

		it("emits the standard web_search tool name for web search markers", () => {
			const result = translateMessage(createMarkdownMessage("[Web Search: ACP tool names]"), sessionState)

			expect(result.updates).toMatchObject([
				{ sessionUpdate: "tool_call", name: "web_search" },
				{ sessionUpdate: "tool_call_update", name: "web_search", status: "in_progress" },
				{ sessionUpdate: "tool_call_update", name: "web_search", status: "completed" },
			])
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

			expect(result.updates).toHaveLength(2)
			expect(result.updates[0].sessionUpdate).toBe("tool_call")
			const toolCall = result.updates[0] as acp.ToolCall
			expect(toolCall.toolCallId).toBe("tool-1")
			expect(toolCall.title).toBe("read_file")
			expect(toolCall.name).toBe("read_file")
			expect(toolCall.status).toBe("pending")
			expect(result.updates[1]).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: "in_progress",
			})
			expect(sessionState.pendingToolCalls.has("tool-1")).toBe(true)
		})

		it("emits permission-agent approvals as completed audit tool calls", () => {
			const result = translateMessage(
				createCardMessage({
					id: "permission-approval-1",
					header: "Auto Approved · Execute: npm run typecheck",
					toolName: "permission_approval",
					status: CardStatus.SUCCESS,
					body: "**Result:** Auto Approved by permission agent\n\n**Reason:** The command is allowed.",
					rawInput: { tool: "execute_command" },
					rawOutput: {
						decision: "approve",
						reason: "The command is allowed.",
						approvedTool: "execute_command",
					},
				}),
				sessionState,
			)

			expect(result.updates).toHaveLength(1)
			expect(result.updates[0]).toMatchObject({
				sessionUpdate: "tool_call",
				name: "permission_approval",
				title: "Auto Approved · Execute: npm run typecheck",
				kind: "other",
				status: "completed",
				rawOutput: {
					decision: "approve",
					reason: "The command is allowed.",
					approvedTool: "execute_command",
				},
			})
			expect(result.requiresPermission).toBe(false)
			expect(result.permissionRequest).toBeUndefined()
		})

		it("reports file edits as ACP diff content with before and after text", () => {
			const result = translateMessage(
				createCardMessage({
					id: "tool-1",
					header: "Edited src/file.ts",
					status: CardStatus.SUCCESS,
					diffs: [{ path: "src/file.ts", oldText: "const before = 1\n", newText: "const after = 2\n" }],
				}),
				sessionState,
			)

			expect(result.updates[0]).toMatchObject({
				sessionUpdate: "tool_call",
				content: [{ type: "diff", path: "src/file.ts", oldText: "const before = 1\n", newText: "const after = 2\n" }],
			})
		})

		it("uses empty old or new text for created and deleted files", () => {
			const created = translateMessage(
				createCardMessage({
					id: "created",
					header: "Wrote new.ts",
					status: CardStatus.SUCCESS,
					diffs: [{ path: "new.ts", oldText: "", newText: "export const created = true\n" }],
				}),
				sessionState,
			)
			const deleted = translateMessage(
				createCardMessage({
					id: "deleted",
					header: "Deleted old.ts",
					status: CardStatus.SUCCESS,
					diffs: [{ path: "old.ts", oldText: "export const obsolete = true\n", newText: "" }],
				}),
				sessionState,
			)

			expect((created.updates[0] as acp.ToolCall).content).toMatchObject([
				{ type: "diff", path: "new.ts", oldText: "", newText: "export const created = true\n" },
			])
			expect((deleted.updates[0] as acp.ToolCall).content).toMatchObject([
				{ type: "diff", path: "old.ts", oldText: "export const obsolete = true\n", newText: "" },
			])
		})

		it("emits a pending-to-in_progress lifecycle with locations for active cards", () => {
			const card = {
				id: "tool-1",
				header: "read_file",
				status: CardStatus.RUNNING,
				locations: [{ path: "src/file.ts", line: 12 }],
			}
			const result = translateMessage(createCardMessage(card), sessionState)

			expect(result.updates).toHaveLength(2)
			expect(result.updates[0]).toMatchObject({
				sessionUpdate: "tool_call",
				kind: "read",
				status: "pending",
				locations: [{ path: "src/file.ts", line: 12 }],
			})
			expect(result.updates[1]).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status: "in_progress",
			})
		})

		it("classifies inspect_ast operations from machine-readable metadata", () => {
			const outline = translateMessage(
				createCardMessage({
					id: "outline-1",
					header: "Localized outline header",
					toolName: "inspect_ast",
					status: CardStatus.SUCCESS,
					rawInput: { tool: "inspect_ast", operation: "outline", paths: ["src"] },
				}),
				sessionState,
			)
			const references = translateMessage(
				createCardMessage({
					id: "references-1",
					header: "Localized references header",
					toolName: "inspect_ast",
					status: CardStatus.SUCCESS,
					rawInput: { tool: "inspect_ast", operation: "references", paths: ["src"], symbols: ["User"] },
				}),
				sessionState,
			)

			expect(outline.updates[0]).toMatchObject({ name: "inspect_ast", kind: "read" })
			expect(references.updates[0]).toMatchObject({ name: "inspect_ast", kind: "search" })
		})

		it("prefers toolName and operation metadata for edit_ast cards", () => {
			const result = translateMessage(
				createCardMessage({
					id: "edit-ast-1",
					header: "Header that must not determine kind",
					toolName: "edit_ast",
					status: CardStatus.WAITING_FOR_INPUT,
					requireApproval: true,
					rawInput: { tool: "inspect_ast", operation: "replace", targets: [{ path: "src/file.ts", symbol: "load" }] },
					rawOutput: { status: "planned", editCount: 1 },
					locations: [{ path: "src/file.ts", line: 8 }],
					diffs: [{ path: "src/file.ts", oldText: "old", newText: "new" }],
				}),
				sessionState,
			)

			expect(result.updates[0]).toMatchObject({
				name: "edit_ast",
				kind: "edit",
				locations: [{ path: "src/file.ts", line: 8 }],
				rawOutput: { status: "planned", editCount: 1 },
			})
			expect(result.permissionRequest?.toolCall).toMatchObject({ name: "edit_ast", kind: "edit" })
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
			expect(update.name).toBe("read_file")
		})

		it("emits agent_message_chunk with completion text when TASK_COMPLETION card succeeds", () => {
			const card1 = {
				id: "completion-1",
				kind: CardKind.TASK_COMPLETION,
				header: "Task Completed",
				toolName: "respond",
				status: CardStatus.RUNNING,
				body: "Task is now complete.",
			}
			const runningResult = translateMessage(createCardMessage(card1), sessionState)
			// Running status emits tool_call, no message chunk
			expect(runningResult.updates).toHaveLength(2) // tool_call + tool_call_update(in_progress)
			expect(runningResult.updates.every((u) => u.sessionUpdate !== "agent_message_chunk")).toBe(true)

			const card2 = {
				id: "completion-1",
				kind: CardKind.TASK_COMPLETION,
				header: "Task Completed",
				toolName: "respond",
				status: CardStatus.SUCCESS,
				body: "Task is now complete.",
			}
			const successResult = translateMessage(createCardMessage(card2), sessionState)
			expect(successResult.updates).toHaveLength(2)
			expect(successResult.updates[0]).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: "completion-1",
				status: "completed",
			})
			expect(successResult.updates[1]).toEqual({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Task is now complete." },
			})
		})

		it("translates legacy task completion card without kind field based on header", () => {
			const card = {
				id: "legacy-comp-1",
				header: "Task Completed",
				status: CardStatus.SUCCESS,
				body: "Legacy task finished.",
			}
			const result = translateMessage(createCardMessage(card), sessionState)
			expect(result.updates).toHaveLength(2)
			expect(result.updates[0].sessionUpdate).toBe("tool_call")
			expect(result.updates[1]).toEqual({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Legacy task finished." },
			})
		})

		it("offers once and always choices for approval requests", () => {
			const card = {
				id: "tool-1",
				header: "execute_command",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
			}
			const result = translateMessage(createCardMessage(card), sessionState)

			expect(result.requiresPermission).toBe(true)
			expect(result.permissionRequest?.options).toEqual([
				{ kind: "allow_once", optionId: "allow_once", name: "Approve once" },
				{ kind: "allow_always", optionId: "allow_always", name: "Always approve" },
				{ kind: "reject_once", optionId: "reject_once", name: "Reject once" },
				{ kind: "reject_always", optionId: "reject_always", name: "Always reject" },
			])
		})

		it("offers only a one-shot declared action for new-task transitions", () => {
			const result = translateMessage(
				createCardMessage({
					id: "new-task-1",
					header: "New Task",
					status: CardStatus.WAITING_FOR_INPUT,
					requireApproval: true,
					rawInput: { tool: "new_task" },
					actions: [{ label: "Approve New Task", value: "new_task", primary: true }],
				}),
				sessionState,
			)

			expect(result.permissionRequest?.options).toEqual([
				{ kind: "allow_once", optionId: "new_task", name: "Approve New Task" },
				{ kind: "reject_once", optionId: "reject_once", name: "Keep current task" },
			])
			expect(result.permissionRequest?.toolCall.name).toBe("new_task")
		})

		it("attaches the pending command and diff to an approval request's tool call", () => {
			const result = translateMessage(
				createCardMessage({
					id: "edit-approval-1",
					header: "edit_file",
					status: CardStatus.WAITING_FOR_INPUT,
					requireApproval: true,
					rawInput: { command: "python apply_edit.py", language: "bash" },
					diffs: [{ path: "src/file.ts", oldText: "const before = true\n", newText: "const after = true\n" }],
				}),
				sessionState,
			)

			expect(result.permissionRequest?.toolCall).toMatchObject({
				toolCallId: "edit-approval-1",
				name: "edit_file",
				rawInput: { command: "python apply_edit.py", language: "bash" },
				content: [
					{ type: "diff", path: "src/file.ts", oldText: "const before = true\n", newText: "const after = true\n" },
				],
			})
		})

		it("attaches a write preview diff to the permission request tool call", () => {
			const result = translateMessage(
				createCardMessage({
					id: "write-approval-1",
					header: "Permission Request",
					status: CardStatus.WAITING_FOR_INPUT,
					requireApproval: true,
					rawInput: { path: "src/new.ts", content: "export const preview = true\n" },
					diffs: [{ path: "src/new.ts", oldText: "", newText: "export const preview = true\n" }],
				}),
				sessionState,
			)

			expect(result.permissionRequest?.toolCall).toMatchObject({
				rawInput: { path: "src/new.ts", content: "export const preview = true\n" },
				content: [{ type: "diff", path: "src/new.ts", oldText: "", newText: "export const preview = true\n" }],
			})
		})

		it("marks always approval and rejection responses for persisted rules", () => {
			const allow = handlePermissionResponse({ outcome: { outcome: "selected", optionId: "allow_always" } } as any, "tool")
			const reject = handlePermissionResponse(
				{ outcome: { outcome: "selected", optionId: "reject_always" } } as any,
				"tool",
			)

			expect(allow).toMatchObject({ response: "approve", persistentAction: "allow" })
			expect(reject).toMatchObject({ response: "reject", persistentAction: "deny" })
		})

		it("does not translate follow-up questions into permission requests", () => {
			const result = translateMessage(
				createCardMessage({
					id: "question-1",
					header: "Question: Choose a target",
					status: CardStatus.WAITING_FOR_INPUT,
					requireFeedback: true,
					rawInput: responseCardInput(ResponseOperation.QUESTION, "Choose a target"),
				}),
				sessionState,
			)

			expect(result.requiresPermission).toBe(false)
			expect(result.permissionRequest).toBeUndefined()
		})

		it("should not create feedback permission when approval has been cleared", () => {
			const card = {
				id: "tool-1",
				header: "execute_command",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: false,
			}
			const message = createCardMessage(card)
			const result = translateMessage(message, sessionState)

			expect(result.requiresPermission).toBe(false)
			expect(result.permissionRequest).toBeUndefined()
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

		it("preserves structured raw tool input and output", () => {
			const created = translateMessage(
				createCardMessage({
					id: "command-1",
					header: "execute_command",
					status: CardStatus.RUNNING,
					rawInput: { command: "npm test", language: "bash" },
				}),
				sessionState,
			)
			expect(created.updates[0]).toMatchObject({
				sessionUpdate: "tool_call",
				rawInput: { command: "npm test", language: "bash" },
			})

			const completed = translateMessage(
				createCardMessage({
					id: "command-1",
					header: "Executed: npm test",
					status: CardStatus.SUCCESS,
					rawInput: { command: "npm test", language: "bash" },
					rawOutput: { output: "all tests passed", exitCode: 0, userRejected: false },
				}),
				sessionState,
			)
			expect(completed.updates[0]).toMatchObject({
				sessionUpdate: "tool_call_update",
				rawInput: { command: "npm test", language: "bash" },
				rawOutput: { output: "all tests passed", exitCode: 0, userRejected: false },
			})
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

	it("skips checkpoint messages", () => {
		const result = translateMessage(createCheckpointMessage(), sessionState)

		expect(result.updates).toHaveLength(0)
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
