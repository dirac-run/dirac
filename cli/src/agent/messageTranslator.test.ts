/**
 * Unit tests for messageTranslator.ts
 *
 * Tests the translation of Dirac messages to ACP session updates,
 * validating conformance to the ACP protocol schema.
 *
 * @see https://agentclientprotocol.com/schema
 */

import type * as acp from "@agentclientprotocol/sdk"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it } from "vitest"
import { createSessionState, translateMessage, translateMessages } from "./messageTranslator"
import type { AcpSessionState } from "./types"
import { AcpSessionStatus } from "./types"

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a minimal DiracMessage for testing.
 */
function createDiracMessage(overrides: Partial<DiracMessage>): DiracMessage {
	return {
		ts: Date.now(),
		type: "say",
		...overrides,
	} as DiracMessage
}

/**
 * Create a fresh session state for testing.
 */
function createTestSessionState(): AcpSessionState {
	return createSessionState("test-session-id")
}

// =============================================================================
// Schema Validation Helpers
// =============================================================================

/**
 * Valid SessionUpdate types per ACP schema.
 */
const VALID_SESSION_UPDATE_TYPES = [
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
	"plan",
	"available_commands_update",
	"current_mode_update",
] as const

/**
 * Valid ToolKind values per ACP schema.
 */
const VALID_TOOL_KINDS: acp.ToolKind[] = [
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other",
]

/**
 * Valid ToolCallStatus values per ACP schema.
 */
const VALID_TOOL_CALL_STATUSES: acp.ToolCallStatus[] = ["pending", "in_progress", "completed", "failed"]

/**
 * Valid PlanEntryStatus values per ACP schema.
 */
const VALID_PLAN_ENTRY_STATUSES: acp.PlanEntryStatus[] = ["pending", "in_progress", "completed"]

/**
 * Valid PlanEntryPriority values per ACP schema.
 */
const VALID_PLAN_ENTRY_PRIORITIES: acp.PlanEntryPriority[] = ["high", "medium", "low"]

/**
 * Valid ContentBlock types per ACP schema.
 */
const VALID_CONTENT_BLOCK_TYPES = ["text", "image", "audio", "resource_link", "resource"] as const

/**
 * Assert that a SessionUpdate has a valid type.
 */
function assertValidSessionUpdateType(update: acp.SessionUpdate): void {
	expect(VALID_SESSION_UPDATE_TYPES).toContain(update.sessionUpdate)
}

/**
 * Assert that a ToolKind is valid per ACP schema.
 */
function assertValidToolKind(kind: acp.ToolKind | undefined): void {
	if (kind !== undefined) {
		expect(VALID_TOOL_KINDS).toContain(kind)
	}
}

/**
 * Assert that a ToolCallStatus is valid per ACP schema.
 */
function assertValidToolCallStatus(status: acp.ToolCallStatus | undefined): void {
	if (status !== undefined) {
		expect(VALID_TOOL_CALL_STATUSES).toContain(status)
	}
}

/**
 * Assert that a tool_call update has the required fields per ACP schema.
 */
function assertValidToolCall(update: acp.SessionUpdate): void {
	if (update.sessionUpdate === "tool_call") {
		const toolCall = update as acp.ToolCall & { sessionUpdate: "tool_call" }
		// Required fields per schema
		expect(toolCall.toolCallId).toBeDefined()
		expect(typeof toolCall.toolCallId).toBe("string")
		expect(toolCall.title).toBeDefined()
		expect(typeof toolCall.title).toBe("string")
		// Optional fields validation
		assertValidToolKind(toolCall.kind)
		assertValidToolCallStatus(toolCall.status)
	}
}

/**
 * Assert that a tool_call_update has the required fields per ACP schema.
 */
function assertValidToolCallUpdate(update: acp.SessionUpdate): void {
	if (update.sessionUpdate === "tool_call_update") {
		const toolCallUpdate = update as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
		// Required field per schema
		expect(toolCallUpdate.toolCallId).toBeDefined()
		expect(typeof toolCallUpdate.toolCallId).toBe("string")
		// Optional fields validation
		assertValidToolKind(toolCallUpdate.kind ?? undefined)
		assertValidToolCallStatus(toolCallUpdate.status ?? undefined)
	}
}

/**
 * Assert that a plan entry has valid fields per ACP schema.
 */
function assertValidPlanEntry(entry: acp.PlanEntry): void {
	expect(entry.content).toBeDefined()
	expect(typeof entry.content).toBe("string")
	expect(VALID_PLAN_ENTRY_STATUSES).toContain(entry.status)
	expect(VALID_PLAN_ENTRY_PRIORITIES).toContain(entry.priority)
}

/**
 * Assert that a ContentBlock has a valid type per ACP schema.
 */
function assertValidContentBlock(content: acp.ContentBlock): void {
	expect(VALID_CONTENT_BLOCK_TYPES).toContain(content.type)
	if (content.type === "text") {
		expect(typeof (content as acp.TextContent).text).toBe("string")
	}
}

// =============================================================================
// Tests: createSessionState
// =============================================================================

describe("createSessionState", () => {
	it("should create a valid session state with correct sessionId", () => {
		const state = createSessionState("my-session-123")

		expect(state.sessionId).toBe("my-session-123")
		expect(state.status).toBe(AcpSessionStatus.Idle)
		expect(state.pendingToolCalls).toBeInstanceOf(Map)
		expect(state.pendingToolCalls.size).toBe(0)
		expect(state.currentToolCallId).toBeUndefined()
	})

	it("should create independent state objects", () => {
		const state1 = createSessionState("session-1")
		const state2 = createSessionState("session-2")

		// Modify state1
		state1.status = AcpSessionStatus.Processing
		state1.pendingToolCalls.set("tool-1", {} as acp.ToolCall)

		// state2 should be unaffected
		expect(state2.status).toBe(AcpSessionStatus.Idle)
		expect(state2.pendingToolCalls.size).toBe(0)
	})
})

// =============================================================================
// Tests: translateMessage - Say Messages
// =============================================================================

describe("translateMessage - say messages", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	describe("text messages", () => {
		it("should translate say:text to agent_message_chunk", () => {
			const message = createDiracMessage({
				type: "say",
				say: "text",
				text: "Hello, this is a response.",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			assertValidSessionUpdateType(result.updates[0])
			expect(result.updates[0].sessionUpdate).toBe("agent_message_chunk")

			const chunk = result.updates[0] as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
			assertValidContentBlock(chunk.content)
			expect(chunk.content.type).toBe("text")
			expect((chunk.content as acp.TextContent).text).toBe("Hello, this is a response.")
		})

		it("should translate Codex web search marker text to a completed search tool call", () => {
			const message = createDiracMessage({
				type: "say",
				say: "text",
				text: "[Web Search: snow model albedo]",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(2)
			expect(result.updates[0].sessionUpdate).toBe("tool_call")
			expect(result.updates[1].sessionUpdate).toBe("tool_call_update")

			const toolCall = result.updates[0] as acp.ToolCall & { sessionUpdate: "tool_call" }
			assertValidToolCall(toolCall)
			expect(toolCall.kind).toBe("search")
			expect(toolCall.status).toBe("in_progress")
			expect(toolCall.title).toBe("Web Search: snow model albedo")
			expect(toolCall.rawInput).toEqual({ query: "snow model albedo" })

			const toolUpdate = result.updates[1] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			assertValidToolCallUpdate(toolUpdate)
			expect(toolUpdate.toolCallId).toBe(toolCall.toolCallId)
			expect(toolUpdate.status).toBe("completed")
			expect(toolUpdate.rawOutput).toEqual({ query: "snow model albedo" })
			expect(sessionState.currentToolCallId).toBeUndefined()
		})

		it("should leave prose containing a web search marker as assistant text", () => {
			const text = "I checked [Web Search: snow model albedo] and found relevant papers."
			const message = createDiracMessage({
				type: "say",
				say: "text",
				text,
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			expect(result.updates[0].sessionUpdate).toBe("agent_message_chunk")
			const chunk = result.updates[0] as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
			expect((chunk.content as acp.TextContent).text).toBe(text)
		})

		it("should use fallback query text for empty web search markers", () => {
			const message = createDiracMessage({
				type: "say",
				say: "text",
				text: "\n[Web Search: ]\n",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(2)
			const toolCall = result.updates[0] as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(toolCall.title).toBe("Web Search: Searching...")
			expect(toolCall.rawInput).toEqual({ query: "Searching..." })
			const toolUpdate = result.updates[1] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(toolUpdate.rawOutput).toEqual({ query: "Searching..." })
		})

		it("should keep partial web search marker tool calls in progress until the final marker arrives", () => {
			const partialMessage = createDiracMessage({
				type: "say",
				say: "text",
				text: "[Web Search: snow model albedo]",
				partial: true,
			})

			const partialResult = translateMessage(partialMessage, sessionState)

			expect(partialResult.updates).toHaveLength(1)
			const toolCall = partialResult.updates[0] as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(toolCall.status).toBe("in_progress")
			expect(sessionState.currentToolCallId).toBe(toolCall.toolCallId)

			const finalMessage = createDiracMessage({
				type: "say",
				say: "text",
				text: "[Web Search: snow model albedo]",
				partial: false,
			})

			const finalResult = translateMessage(finalMessage, sessionState)

			expect(finalResult.updates).toHaveLength(1)
			expect(finalResult.updates[0].sessionUpdate).toBe("tool_call_update")
			const completedUpdate = finalResult.updates[0] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(completedUpdate.toolCallId).toBe(toolCall.toolCallId)
			expect(completedUpdate.status).toBe("completed")
			expect(sessionState.currentToolCallId).toBeUndefined()
		})

		it("should not generate update for empty text", () => {
			const message = createDiracMessage({
				type: "say",
				say: "text",
				text: "",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(0)
		})

		it("should not generate update for undefined text", () => {
			const message = createDiracMessage({
				type: "say",
				say: "text",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(0)
		})
	})

	describe("reasoning messages", () => {
		it("should translate say:reasoning to agent_thought_chunk", () => {
			const message = createDiracMessage({
				type: "say",
				say: "reasoning",
				reasoning: "I need to analyze the code structure first.",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			assertValidSessionUpdateType(result.updates[0])
			expect(result.updates[0].sessionUpdate).toBe("agent_thought_chunk")

			const chunk = result.updates[0] as acp.ContentChunk & { sessionUpdate: "agent_thought_chunk" }
			assertValidContentBlock(chunk.content)
			expect(chunk.content.type).toBe("text")
			expect((chunk.content as acp.TextContent).text).toBe("I need to analyze the code structure first.")
		})

		it("should fall back to text field if reasoning is undefined", () => {
			const message = createDiracMessage({
				type: "say",
				say: "reasoning",
				text: "Thinking about the problem...",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(1)
			expect(result.updates[0].sessionUpdate).toBe("agent_thought_chunk")

			const chunk = result.updates[0] as acp.ContentChunk & { sessionUpdate: "agent_thought_chunk" }
			expect((chunk.content as acp.TextContent).text).toBe("Thinking about the problem...")
		})
	})

	describe("error messages", () => {
		it("should translate say:error to a failed tool_call lifecycle", () => {
			const message = createDiracMessage({
				type: "say",
				say: "error",
				text: "Failed to read file",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(2)

			const toolCall = result.updates[0] as acp.ToolCall & { sessionUpdate: "tool_call" }
			assertValidToolCall(toolCall)
			expect(toolCall.sessionUpdate).toBe("tool_call")
			expect(toolCall.status).toBe("in_progress")
			expect(toolCall.kind).toBe("other")

			const toolUpdate = result.updates[1] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			assertValidToolCallUpdate(toolUpdate)
			expect(toolUpdate.sessionUpdate).toBe("tool_call_update")
			expect(toolUpdate.toolCallId).toBe(toolCall.toolCallId)
			expect(toolUpdate.status).toBe("failed")
			expect((toolUpdate as any).rawOutput).toEqual({ error: "Failed to read file" })
		})

		it("should update current tool call to failed status on error", () => {
			sessionState.currentToolCallId = "active-tool-123"

			const message = createDiracMessage({
				type: "say",
				say: "error",
				text: "Operation failed",
			})

			const result = translateMessage(message, sessionState)

			const toolUpdate = result.updates.find((u) => u.sessionUpdate === "tool_call_update")
			expect(toolUpdate).toBeDefined()
			assertValidToolCallUpdate(toolUpdate!)

			const update = toolUpdate as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(update.toolCallId).toBe("active-tool-123")
			expect(update.status).toBe("failed")

			// Should clear the current tool call ID
			expect(sessionState.currentToolCallId).toBeUndefined()
		})

		it("should handle error_retry message type", () => {
			const message = createDiracMessage({
				type: "say",
				say: "error_retry",
				text: "Retrying after failure",
			})

			const result = translateMessage(message, sessionState)

			// Non-JSON error_retry text is treated as a plain retry: a tool_call in_progress
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()
			assertValidToolCall(toolCall!)
			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.status).toBe("in_progress")
			expect(sessionState.retryToolCallId).toBeDefined()
		})

		it("should handle diff_error message type", () => {
			const message = createDiracMessage({
				type: "say",
				say: "diff_error",
				text: "Diff application failed",
			})

			const result = translateMessage(message, sessionState)

			// diff_error is rendered as a failed tool_call lifecycle
			expect(result.updates).toHaveLength(2)

			const toolCall = result.updates[0] as acp.ToolCall & { sessionUpdate: "tool_call" }
			assertValidToolCall(toolCall)
			expect(toolCall.sessionUpdate).toBe("tool_call")
			expect(toolCall.status).toBe("in_progress")

			const toolUpdate = result.updates[1] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			assertValidToolCallUpdate(toolUpdate)
			expect(toolUpdate.sessionUpdate).toBe("tool_call_update")
			expect(toolUpdate.toolCallId).toBe(toolCall.toolCallId)
			expect(toolUpdate.status).toBe("failed")
			expect((toolUpdate as any).rawOutput).toEqual({ error: "Diff application failed" })
		})
	})

	describe("command messages", () => {
		it("should translate say:command to tool_call with execute kind", () => {
			const message = createDiracMessage({
				type: "say",
				say: "command",
				text: "npm install",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates.length).toBeGreaterThanOrEqual(1)
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()
			assertValidToolCall(toolCall!)

			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.kind).toBe("execute")
			expect(call.title).toContain("npm install")
			expect(call.status).toBe("in_progress")
			expect(call.rawInput).toEqual({ command: "npm install" })

			// Should set currentToolCallId
			expect(sessionState.currentToolCallId).toBe(call.toolCallId)
		})

		it("should use terminal content when the client supports terminal output", () => {
			const message = createDiracMessage({
				type: "say",
				say: "command",
				text: "npm test",
			})

			const result = translateMessage(message, sessionState, {
				clientCapabilities: { _meta: { terminal_output: true } },
			})

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}

			expect(toolCall.content).toEqual([{ type: "terminal", terminalId: toolCall.toolCallId }])
			expect((toolCall as any)._meta).toEqual({
				terminal_info: {
					terminal_id: toolCall.toolCallId,
				},
			})
		})

		it("should truncate long command titles", () => {
			const longCommand = "npm install --save-dev very-long-package-name-that-exceeds-fifty-characters-limit"
			const message = createDiracMessage({
				type: "say",
				say: "command",
				text: longCommand,
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}
			// Title format is "Execute: {command up to 50 chars}..." so max ~63 chars
			expect(toolCall.title.length).toBeLessThanOrEqual(65)
			expect(toolCall.title).toContain("...")
		})
	})

	describe("command_output messages", () => {
		it("should translate say:command_output to tool_call_update when tool is active", () => {
			sessionState.currentToolCallId = "command-tool-123"

			const message = createDiracMessage({
				type: "say",
				say: "command_output",
				text: "added 5 packages",
				commandCompleted: false,
			})

			const result = translateMessage(message, sessionState)

			const toolUpdate = result.updates.find((u) => u.sessionUpdate === "tool_call_update")
			expect(toolUpdate).toBeDefined()
			assertValidToolCallUpdate(toolUpdate!)

			const update = toolUpdate as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(update.toolCallId).toBe("command-tool-123")
			expect(update.status).toBe("in_progress")
			expect(update.rawOutput).toEqual({ output: "added 5 packages" })
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```console\nadded 5 packages\n```" },
				},
			])
			expect((update as any)._meta).toBeUndefined()
		})

		it("should mark tool as completed when commandCompleted is true", () => {
			sessionState.currentToolCallId = "command-tool-456"

			const message = createDiracMessage({
				type: "say",
				say: "command_output",
				text: "Done!",
				commandCompleted: true,
			})

			const result = translateMessage(message, sessionState)

			const toolUpdate = result.updates.find((u) => u.sessionUpdate === "tool_call_update") as acp.ToolCallUpdate & {
				sessionUpdate: "tool_call_update"
			}
			expect(toolUpdate.status).toBe("completed")

			// Should clear currentToolCallId
			expect(sessionState.currentToolCallId).toBeUndefined()
		})

		it("should stream terminal output metadata for terminal-capable clients", () => {
			sessionState.currentToolCallId = "command-tool-terminal"

			const result = translateMessage(
				createDiracMessage({
					type: "say",
					say: "command_output",
					text: "line 1\n",
					commandCompleted: false,
				}),
				sessionState,
				{ clientCapabilities: { _meta: { terminal_output: true } } },
			)

			expect(result.updates).toHaveLength(1)
			const update = result.updates[0] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(update.sessionUpdate).toBe("tool_call_update")
			expect(update.toolCallId).toBe("command-tool-terminal")
			expect(update.status).toBeUndefined()
			expect(update.content).toBeUndefined()
			expect(update.rawOutput).toBeUndefined()
			expect((update as any)._meta).toEqual({
				terminal_output: {
					terminal_id: "command-tool-terminal",
					data: "line 1\n",
				},
			})
			expect(sessionState.currentToolCallId).toBe("command-tool-terminal")
		})

		it("should send terminal exit metadata separately and clear currentToolCallId", () => {
			sessionState.currentToolCallId = "command-tool-terminal"

			const result = translateMessage(
				createDiracMessage({
					type: "say",
					say: "command_output",
					text: "tests passed",
					commandCompleted: true,
				}),
				sessionState,
				{ clientCapabilities: { _meta: { terminal_output: true } } },
			)

			expect(result.updates).toHaveLength(2)
			const outputUpdate = result.updates[0] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect((outputUpdate as any)._meta).toEqual({
				terminal_output: {
					terminal_id: "command-tool-terminal",
					data: "tests passed",
				},
			})
			expect(outputUpdate.status).toBeUndefined()

			const exitUpdate = result.updates[1] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(exitUpdate.toolCallId).toBe("command-tool-terminal")
			expect(exitUpdate.status).toBe("completed")
			expect(exitUpdate.rawOutput).toEqual({ output: "tests passed" })
			expect((exitUpdate as any)._meta).toEqual({
				terminal_exit: {
					terminal_id: "command-tool-terminal",
					exit_code: 0,
					signal: null,
				},
			})
			expect(sessionState.currentToolCallId).toBeUndefined()
		})

		it("should fall back to agent_message_chunk when no active tool", () => {
			const message = createDiracMessage({
				type: "say",
				say: "command_output",
				text: "Output without active tool",
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()
		})
	})

	describe("tool messages", () => {
		it("should translate say:tool for file read operations", () => {
			const toolInfo = {
				tool: "readFile",
				path: "/src/index.ts",
				content: "export const hello = 'world';",
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()
			assertValidToolCall(toolCall!)

			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.kind).toBe("read")
			expect(call.status).toBe("in_progress")
			expect(call.title).toContain("Read")
			expect(call.title).toContain("/src/index.ts")
			expect(call.locations).toContainEqual({ path: "/src/index.ts" })

			const toolUpdate = result.updates.find((u) => u.sessionUpdate === "tool_call_update")
			expect(toolUpdate).toBeDefined()
			assertValidToolCallUpdate(toolUpdate!)
			expect((toolUpdate as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }).status).toBe("completed")
		})

		it("should build read titles from paths when path is omitted", () => {
			const toolInfo = {
				tool: "readFile",
				paths: ["/src/a.ts", "/src/b.ts"],
				readFileResults: [
					{ path: "/src/a.ts", status: "success", label: "Read full file" },
					{ path: "/src/b.ts", status: "success", label: "Read full file" },
				],
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}

			expect(toolCall.title).toContain("/src/a.ts")
			expect(toolCall.title).toContain("/src/b.ts")
		})

		it("should deduplicate paths in title when path, paths, and readFileResults all reference the same file", () => {
			const toolInfo = {
				tool: "readFile",
				path: "/src/index.ts",
				paths: ["/src/index.ts"],
				content: "[File Hash: abc123]\nconst x = 1\n",
				readFileResults: [{ path: "/src/index.ts", status: "success", label: "Read full file" }],
			}
			const message = createDiracMessage({ type: "say", say: "tool", text: JSON.stringify(toolInfo) })

			const result = translateMessage(message, sessionState)
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}

			expect(toolCall.title).toBe("Read /src/index.ts")
		})

		it("should format readFile content as hash bullet instead of full source", () => {
			const toolInfo = {
				tool: "readFile",
				path: "/src/index.ts",
				paths: ["/src/index.ts"],
				content: "[File Hash: abc123]\nconst x = 1\nexport default x\n",
				readFileResults: [{ path: "/src/index.ts", status: "success", label: "Read full file" }],
			}
			const message = createDiracMessage({ type: "say", say: "tool", text: JSON.stringify(toolInfo) })

			const result = translateMessage(message, sessionState)
			const update = result.updates.find((u) => u.sessionUpdate === "tool_call_update") as any
			expect(update).toBeDefined()
			const contentText = update?.content?.[0]?.content?.text as string
			expect(contentText).toBe("* /src/index.ts: [File Hash: abc123]")
			expect(contentText).not.toContain("const x = 1")
		})

		it("should format listFilesTopLevel content as markdown bullets", () => {
			const toolInfo = {
				tool: "listFilesTopLevel",
				path: ".",
				content:
					"Contents of .:\n[Note: sorted by mtime]\n\n3 out of 3 elements listed below:\n\nfoo.ts\nbar.ts\nbaz/",
			}
			const message = createDiracMessage({ type: "say", say: "tool", text: JSON.stringify(toolInfo) })

			const result = translateMessage(message, sessionState)
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as any
			const contentText = toolCall?.content?.[0]?.content?.text as string
			expect(contentText).toBe("* foo.ts\n* bar.ts\n* baz/")
			expect(contentText).not.toContain("Contents of")
			expect(contentText).not.toContain("[Note:")
		})

		it("should format newFileCreated content as hash bullet instead of full source", () => {
			const toolInfo = {
				tool: "newFileCreated",
				path: "/src/new.ts",
				content: "[File Hash: def456]\nexport const x = 1\n",
			}
			const message = createDiracMessage({ type: "say", say: "tool", text: JSON.stringify(toolInfo) })

			const result = translateMessage(message, sessionState)
			const update = result.updates.find((u) => u.sessionUpdate === "tool_call_update") as any
			expect(update).toBeDefined()
			const contentText = update?.content?.[0]?.content?.text as string
			expect(contentText).toBe("* /src/new.ts: [File Hash: def456]")
			expect(contentText).not.toContain("export const")
		})

		it("should translate say:tool for file edit operations", () => {
			const toolInfo = {
				tool: "editedExistingFile",
				path: "/src/app.ts",
				diff: `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 console.log(x);`,
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()

			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.kind).toBe("edit")
			expect(call.status).toBe("in_progress")
			expect(call.title).toContain("Edit")
			expect(call.title).toContain("/src/app.ts")

			// Should have diff content
			const diffContent = call.content?.find((c) => c.type === "diff")
			expect(diffContent).toBeDefined()
		})

		it("should translate say:tool for file creation", () => {
			const toolInfo = {
				tool: "newFileCreated",
				path: "/src/new-file.ts",
				content: "// New file content",
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}
			expect(toolCall.kind).toBe("edit")
			expect(toolCall.status).toBe("in_progress")
			expect(toolCall.title).toContain("Create")
		})

		it("should translate say:tool for file deletion", () => {
			const toolInfo = {
				tool: "fileDeleted",
				path: "/src/old-file.ts",
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}
			expect(toolCall.kind).toBe("delete")
			expect(toolCall.status).toBe("in_progress")
			expect(toolCall.title).toContain("Delete")
		})

		it("should translate say:tool for search operations", () => {
			const toolInfo = {
				tool: "searchFiles",
				path: "/src",
				regex: "TODO|FIXME",
				content: "Found 3 matches...",
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}
			expect(toolCall.kind).toBe("search")
			expect(toolCall.status).toBe("in_progress")
			expect(toolCall.title).toContain("Search")
			expect(toolCall.title).toContain("TODO|FIXME")
		})

		it("should handle partial tool messages (streaming)", () => {
			const toolInfo = {
				tool: "readFile",
				path: "/src/large-file.ts",
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
				partial: true,
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}
			expect(toolCall.status).toBe("in_progress")
		})

		it("should send tool_call_update for subsequent updates to same tool", () => {
			// First message creates the tool call
			sessionState.currentToolCallId = "existing-tool-123"

			const toolInfo = {
				tool: "readFile",
				path: "/src/file.ts",
				content: "More content...",
			}
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
				partial: false,
			})

			const result = translateMessage(message, sessionState)

			const toolUpdate = result.updates.find((u) => u.sessionUpdate === "tool_call_update")
			expect(toolUpdate).toBeDefined()
		})

		it("should handle invalid JSON in tool message gracefully", () => {
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: "not valid json",
			})

			const result = translateMessage(message, sessionState)

			// Should fall back to agent_message_chunk
			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()
		})

		it("should advance partial ask:tool command previews when an auto-approved say:tool command arrives", () => {
			const toolInfo = {
				tool: "execute_command",
				command: "npm test",
			}
			const askMessage = createDiracMessage({
				type: "ask",
				ask: "tool",
				text: JSON.stringify(toolInfo),
				partial: true,
			})

			const askResult = translateMessage(askMessage, sessionState)
			const toolCall = askResult.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}

			expect(askResult.requiresPermission).toBe(false)
			expect(toolCall.kind).toBe("execute")
			expect(toolCall.status).toBe("pending")
			expect(sessionState.currentToolCallId).toBe(toolCall.toolCallId)

			const sayMessage = createDiracMessage({
				type: "say",
				say: "tool",
				text: "npm test",
			})

			const sayResult = translateMessage(sayMessage, sessionState)

			expect(sayResult.requiresPermission).toBe(false)
			expect(sayResult.permissionRequest).toBeUndefined()
			expect(sayResult.updates).toHaveLength(1)
			const update = sayResult.updates[0] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(update.sessionUpdate).toBe("tool_call_update")
			expect(update.toolCallId).toBe(toolCall.toolCallId)
			expect(update.status).toBe("in_progress")
			expect(update.rawInput).toEqual({ command: "npm test" })
			expect(sessionState.pendingToolCalls.get(toolCall.toolCallId)?.status).toBe("in_progress")
		})

		it("should let auto-approved command output complete the previewed command tool call", () => {
			const askResult = translateMessage(
				createDiracMessage({
					type: "ask",
					ask: "tool",
					text: JSON.stringify({ tool: "execute_command", command: "npm test" }),
					partial: true,
				}),
				sessionState,
			)
			const toolCall = askResult.updates[0] as acp.ToolCall & { sessionUpdate: "tool_call" }

			translateMessage(
				createDiracMessage({
					type: "say",
					say: "tool",
					text: "npm test",
				}),
				sessionState,
			)

			const outputResult = translateMessage(
				createDiracMessage({
					type: "say",
					say: "command_output",
					text: "tests passed",
					commandCompleted: true,
				}),
				sessionState,
			)

			const update = outputResult.updates[0] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(update.sessionUpdate).toBe("tool_call_update")
			expect(update.toolCallId).toBe(toolCall.toolCallId)
			expect(update.status).toBe("completed")
			expect(update.rawOutput).toEqual({ output: "tests passed" })
			expect(sessionState.currentToolCallId).toBeUndefined()
		})

		it("should let terminal-capable auto-approved command output complete the previewed command tool call", () => {
			const clientOptions = { clientCapabilities: { _meta: { terminal_output: true } } }
			const askResult = translateMessage(
				createDiracMessage({
					type: "ask",
					ask: "tool",
					text: JSON.stringify({ tool: "execute_command", command: "npm test" }),
					partial: true,
				}),
				sessionState,
				clientOptions,
			)
			const toolCall = askResult.updates[0] as acp.ToolCall & { sessionUpdate: "tool_call" }

			const commandPreview = translateMessage(
				createDiracMessage({
					type: "say",
					say: "tool",
					text: "npm test",
				}),
				sessionState,
				clientOptions,
			)
			const previewUpdate = commandPreview.updates[0] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(previewUpdate.toolCallId).toBe(toolCall.toolCallId)
			expect(previewUpdate.content).toEqual([{ type: "terminal", terminalId: toolCall.toolCallId }])

			const outputResult = translateMessage(
				createDiracMessage({
					type: "say",
					say: "command_output",
					text: "tests passed",
					commandCompleted: true,
				}),
				sessionState,
				clientOptions,
			)

			const outputUpdate = outputResult.updates[0] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			const exitUpdate = outputResult.updates[1] as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(outputUpdate.toolCallId).toBe(toolCall.toolCallId)
			expect((outputUpdate as any)._meta?.terminal_output).toEqual({
				terminal_id: toolCall.toolCallId,
				data: "tests passed",
			})
			expect(exitUpdate.toolCallId).toBe(toolCall.toolCallId)
			expect(exitUpdate.status).toBe("completed")
			expect((exitUpdate as any)._meta?.terminal_exit).toEqual({
				terminal_id: toolCall.toolCallId,
				exit_code: 0,
				signal: null,
			})
			expect(sessionState.currentToolCallId).toBeUndefined()
		})
	})

	describe("browser action messages", () => {
		it("should translate say:browser_action_launch to tool_call", () => {
			const actionInfo = {
				action: "launch",
				url: "https://example.com",
			}
			const message = createDiracMessage({
				type: "say",
				say: "browser_action_launch",
				text: JSON.stringify(actionInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()
			assertValidToolCall(toolCall!)

			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.kind).toBe("execute")
			expect(call.status).toBe("in_progress")
			expect(call.title).toContain("launch")
		})

		it("should translate say:browser_action to tool_call", () => {
			const actionInfo = {
				action: "click",
				coordinate: [100, 200],
			}
			const message = createDiracMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify(actionInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()

			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.status).toBe("in_progress")
			expect(call.title).toContain("click")
		})

		it("should translate say:browser_action_result to tool_call_update", () => {
			sessionState.currentToolCallId = "browser-tool-123"

			const resultInfo = {
				screenshot: "base64data...",
				success: true,
			}
			const message = createDiracMessage({
				type: "say",
				say: "browser_action_result",
				text: JSON.stringify(resultInfo),
			})

			const result = translateMessage(message, sessionState)

			const toolUpdate = result.updates.find((u) => u.sessionUpdate === "tool_call_update")
			expect(toolUpdate).toBeDefined()

			const update = toolUpdate as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(update.status).toBe("completed")
		})
	})

	describe("completion messages", () => {
		it("should translate say:completion_result to agent_message_chunk", () => {
			const message = createDiracMessage({
				type: "say",
				say: "completion_result",
				text: "Task completed successfully!",
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()

			const chunk = messageChunk as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
			expect((chunk.content as acp.TextContent).text).toBe("\nTask completed successfully!")
		})
	})


	describe("informational messages", () => {
		it("should translate say:info to agent_message_chunk", () => {
			const message = createDiracMessage({
				type: "say",
				say: "info",
				text: "Some informational message",
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()
		})

		it("should not echo user feedback back", () => {
			const message = createDiracMessage({
				type: "say",
				say: "user_feedback",
				text: "User's input text",
			})

			const result = translateMessage(message, sessionState)

			// Should not produce any updates for user feedback
			expect(result.updates).toHaveLength(0)
		})

		it("should not echo task message back", () => {
			const message = createDiracMessage({
				type: "say",
				say: "task",
				text: "User's original prompt",
			})

			const result = translateMessage(message, sessionState)

			// Should not echo the user's prompt back
			expect(result.updates).toHaveLength(0)
		})
	})

	describe("hook status messages", () => {
		it("should format hook_status as human-readable message", () => {
			const hookInfo = {
				hookName: "pre-commit",
				status: "running",
				toolName: "write_to_file",
			}
			const message = createDiracMessage({
				type: "say",
				say: "hook_status",
				text: JSON.stringify(hookInfo),
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()

			const chunk = messageChunk as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
			expect((chunk.content as acp.TextContent).text).toContain("pre-commit")
			// The status is formatted with capital R: "Running..."
			expect((chunk.content as acp.TextContent).text.toLowerCase()).toContain("running")
		})

		it("should suppress hook_output_stream messages", () => {
			const message = createDiracMessage({
				type: "say",
				say: "hook_output_stream",
				text: "verbose hook output...",
			})

			const result = translateMessage(message, sessionState)

			expect(result.updates).toHaveLength(0)
		})
	})
})

// =============================================================================
// Tests: translateMessage - Ask Messages
// =============================================================================

describe("translateMessage - ask messages", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	describe("followup questions", () => {
		it("should translate ask:followup to agent_message_chunk", () => {
			const followupData = {
				question: "What would you like me to do next?",
				options: ["Continue", "Stop"],
			}
			const message = createDiracMessage({
				type: "ask",
				ask: "followup",
				text: JSON.stringify(followupData),
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()

			const chunk = messageChunk as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
			expect((chunk.content as acp.TextContent).text).toBe("What would you like me to do next?")

			// Should not require permission for followup
			expect(result.requiresPermission).toBe(false)
		})

		it("should handle plain text followup", () => {
			const message = createDiracMessage({
				type: "ask",
				ask: "followup",
				text: "Do you want to continue?",
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			const chunk = messageChunk as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
			expect((chunk.content as acp.TextContent).text).toBe("Do you want to continue?")
		})
	})

	describe("plan mode respond", () => {
		it("should translate ask:plan_mode_respond to agent_message_chunk", () => {
			const planResponse = {
				response: "Here is my plan for the task...",
				options: ["Approve", "Revise"],
			}
			const message = createDiracMessage({
				type: "ask",
				ask: "plan_mode_respond",
				text: JSON.stringify(planResponse),
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()

			const chunk = messageChunk as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
			expect((chunk.content as acp.TextContent).text).toBe("Here is my plan for the task...")
		})
	})

	describe("command permissions", () => {
		it("should translate ask:command to tool_call with permission request", () => {
			const message = createDiracMessage({
				type: "ask",
				ask: "command",
				text: "rm -rf node_modules",
			})

			const result = translateMessage(message, sessionState)

			// Should create a tool_call
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()
			assertValidToolCall(toolCall!)

			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.kind).toBe("execute")
			expect(call.status).toBe("pending")
			expect(call.title).toContain("rm -rf node_modules")

			// Should require permission
			expect(result.requiresPermission).toBe(true)
			expect(result.permissionRequest).toBeDefined()
			expect(result.permissionRequest!.toolCall.toolCallId).toBe(call.toolCallId)

			// Should have standard permission options
			expect(result.permissionRequest!.options).toHaveLength(3)
			expect(result.permissionRequest!.options.map((o) => o.kind)).toContain("allow_once")
			expect(result.permissionRequest!.options.map((o) => o.kind)).toContain("allow_always")
			expect(result.permissionRequest!.options.map((o) => o.kind)).toContain("reject_once")

			// Should track pending tool call
			expect(sessionState.pendingToolCalls.has(call.toolCallId)).toBe(true)
		})
	})

	describe("tool permissions", () => {
		it("should translate ask:tool to tool_call with permission request", () => {
			const toolInfo = {
				tool: "editedExistingFile",
				path: "/src/config.ts",
				diff: "...",
			}
			const message = createDiracMessage({
				type: "ask",
				ask: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)

			// Should create a tool_call
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()
			assertValidToolCall(toolCall!)

			const call = toolCall as acp.ToolCall & { sessionUpdate: "tool_call" }
			expect(call.kind).toBe("edit")
			expect(call.status).toBe("pending")

			// Should require permission
			expect(result.requiresPermission).toBe(true)
			expect(result.permissionRequest).toBeDefined()

			// Should return toolCallId for tracking
			expect(result.toolCallId).toBe(call.toolCallId)
		})

		it("should not require permission for partial tool messages", () => {
			const toolInfo = {
				tool: "readFile",
				path: "/src/file.ts",
			}
			const message = createDiracMessage({
				type: "ask",
				ask: "tool",
				text: JSON.stringify(toolInfo),
				partial: true,
			})

			const result = translateMessage(message, sessionState)

			// Should create tool_call but not require permission yet
			expect(result.requiresPermission).toBe(false)
		})

		it("should use existing toolCallId when provided in options", () => {
			const toolInfo = {
				tool: "editedExistingFile",
				path: "/src/file.ts",
			}
			const message = createDiracMessage({
				type: "ask",
				ask: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState, {
				existingToolCallId: "pre-existing-id-123",
			})

			// Should send tool_call_update instead of new tool_call
			const toolUpdate = result.updates.find((u) => u.sessionUpdate === "tool_call_update")
			expect(toolUpdate).toBeDefined()

			const update = toolUpdate as acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }
			expect(update.toolCallId).toBe("pre-existing-id-123")
		})
	})

	describe("browser action permissions", () => {
		it("should translate ask:browser_action_launch to tool_call with permission", () => {
			const message = createDiracMessage({
				type: "ask",
				ask: "browser_action_launch",
				text: "https://suspicious-site.com",
			})

			const result = translateMessage(message, sessionState)

			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call")
			expect(toolCall).toBeDefined()

			// Should require permission
			expect(result.requiresPermission).toBe(true)

			// Browser actions have restricted options (no "always allow")
			expect(result.permissionRequest!.options).toHaveLength(2)
			expect(result.permissionRequest!.options.map((o) => o.kind)).not.toContain("allow_always")
		})
	})

	describe("completion and resume asks", () => {
		it("should translate ask:completion_result to agent_message_chunk", () => {
			const message = createDiracMessage({
				type: "ask",
				ask: "completion_result",
				text: "Task completed. Would you like to review?",
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()

			// Should not require permission
			expect(result.requiresPermission).toBe(false)
		})

		it("should translate ask:resume_task to agent_message_chunk", () => {
			const message = createDiracMessage({
				type: "ask",
				ask: "resume_task",
				text: "Would you like to resume the previous task?",
			})

			const result = translateMessage(message, sessionState)

			const messageChunk = result.updates.find((u) => u.sessionUpdate === "agent_message_chunk")
			expect(messageChunk).toBeDefined()
		})
	})
})

// =============================================================================
// Tests: translateMessages (batch)
// =============================================================================

describe("translateMessages", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	it("should translate multiple messages in sequence", () => {
		const messages: DiracMessage[] = [
			createDiracMessage({ type: "say", say: "text", text: "First message" }),
			createDiracMessage({ type: "say", say: "reasoning", reasoning: "Thinking..." }),
			createDiracMessage({ type: "say", say: "text", text: "Second message" }),
		]

		const updates = translateMessages(messages, sessionState)

		expect(updates).toHaveLength(3)
		expect(updates[0].sessionUpdate).toBe("agent_message_chunk")
		expect(updates[1].sessionUpdate).toBe("agent_thought_chunk")
		expect(updates[2].sessionUpdate).toBe("agent_message_chunk")
	})

	it("should maintain session state across messages", () => {
		const messages: DiracMessage[] = [
			createDiracMessage({ type: "say", say: "command", text: "npm test" }),
			createDiracMessage({ type: "say", say: "command_output", text: "All tests passed", commandCompleted: true }),
		]

		const updates = translateMessages(messages, sessionState)

		// First message should create tool_call
		const toolCall = updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & { sessionUpdate: "tool_call" }
		expect(toolCall).toBeDefined()

		// Second message should update that tool_call
		const toolUpdate = updates.find((u) => u.sessionUpdate === "tool_call_update") as acp.ToolCallUpdate & {
			sessionUpdate: "tool_call_update"
		}
		expect(toolUpdate).toBeDefined()
		expect(toolUpdate.toolCallId).toBe(toolCall.toolCallId)
		expect(toolUpdate.status).toBe("completed")
	})

	it("should handle empty message array", () => {
		const updates = translateMessages([], sessionState)

		expect(updates).toHaveLength(0)
	})
})

// =============================================================================
// Tests: Diff Parsing
// =============================================================================

describe("diff parsing", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	it("should parse unified diff with additions", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 console.log(a);`

		const toolInfo = {
			tool: "editedExistingFile",
			path: "/file.ts",
			diff: diff,
		}
		const message = createDiracMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify(toolInfo),
		})

		const result = translateMessage(message, sessionState)
		const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
			sessionUpdate: "tool_call"
		}

		const diffContent = toolCall.content?.find((c) => c.type === "diff") as acp.Diff & { type: "diff" }
		expect(diffContent).toBeDefined()
		expect(diffContent.path).toBe("/file.ts")
		expect(diffContent.oldText).not.toContain("const b = 2;")
		expect(diffContent.newText).toContain("const b = 2;")
	})

	it("should parse unified diff with deletions", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,2 @@
 const a = 1;
-const b = 2;
 console.log(a);`

		const toolInfo = {
			tool: "editedExistingFile",
			path: "/file.ts",
			diff: diff,
		}
		const message = createDiracMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify(toolInfo),
		})

		const result = translateMessage(message, sessionState)
		const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
			sessionUpdate: "tool_call"
		}

		const diffContent = toolCall.content?.find((c) => c.type === "diff") as acp.Diff & { type: "diff" }
		expect(diffContent.oldText).toContain("const b = 2;")
		expect(diffContent.newText).not.toContain("const b = 2;")
	})

	it("should parse unified diff with replacements", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 console.log(a);`

		const toolInfo = {
			tool: "editedExistingFile",
			path: "/file.ts",
			diff: diff,
		}
		const message = createDiracMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify(toolInfo),
		})

		const result = translateMessage(message, sessionState)
		const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
			sessionUpdate: "tool_call"
		}

		const diffContent = toolCall.content?.find((c) => c.type === "diff") as acp.Diff & { type: "diff" }
		expect(diffContent.oldText).toContain("const b = 2;")
		expect(diffContent.newText).toContain("const b = 3;")
	})

	it("should handle multiple hunks", () => {
		const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
-const a = 1;
+const a = 10;
 const b = 2;
 const c = 3;
@@ -10,3 +10,3 @@
 const x = 1;
-const y = 2;
+const y = 20;
 const z = 3;`

		const toolInfo = {
			tool: "editedExistingFile",
			path: "/file.ts",
			diff: diff,
		}
		const message = createDiracMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify(toolInfo),
		})

		const result = translateMessage(message, sessionState)
		const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
			sessionUpdate: "tool_call"
		}

		const diffContent = toolCall.content?.find((c) => c.type === "diff") as acp.Diff & { type: "diff" }
		expect(diffContent.oldText).toContain("const a = 1;")
		expect(diffContent.newText).toContain("const a = 10;")
		expect(diffContent.oldText).toContain("const y = 2;")
		expect(diffContent.newText).toContain("const y = 20;")
	})
})

// =============================================================================
// Tests: Tool Kind Mapping
// =============================================================================

describe("tool kind mapping", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	const toolKindCases: Array<{ tool: string; expectedKind: acp.ToolKind }> = [
		{ tool: "readFile", expectedKind: "read" },
		{ tool: "listFilesTopLevel", expectedKind: "read" },
		{ tool: "listFilesRecursive", expectedKind: "read" },
		{ tool: "listCodeDefinitionNames", expectedKind: "read" },
		{ tool: "editedExistingFile", expectedKind: "edit" },
		{ tool: "newFileCreated", expectedKind: "edit" },
		{ tool: "fileDeleted", expectedKind: "delete" },
		{ tool: "searchFiles", expectedKind: "search" },
		{ tool: "summarizeTask", expectedKind: "think" },
		{ tool: "useSkill", expectedKind: "other" },
	]

	toolKindCases.forEach(({ tool, expectedKind }) => {
		it(`should map ${tool} to kind "${expectedKind}"`, () => {
			const toolInfo = { tool, path: "/test/path" }
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}

			expect(toolCall.kind).toBe(expectedKind)
			assertValidToolKind(toolCall.kind)
		})
	})

	it("should default to 'other' for unknown tool types", () => {
		const toolInfo = { tool: "unknownTool", path: "/test" }
		const message = createDiracMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify(toolInfo),
		})

		const result = translateMessage(message, sessionState)
		const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
			sessionUpdate: "tool_call"
		}

		expect(toolCall.kind).toBe("other")
	})
})

// =============================================================================
// Tests: Tool Title Building
// =============================================================================

describe("tool title building", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	const titleCases: Array<{ tool: string; path?: string; regex?: string; expectedContains: string }> = [
		{ tool: "readFile", path: "/src/index.ts", expectedContains: "Read /src/index.ts" },
		{ tool: "editedExistingFile", path: "/src/app.ts", expectedContains: "Edit /src/app.ts" },
		{ tool: "newFileCreated", path: "/src/new.ts", expectedContains: "Create /src/new.ts" },
		{ tool: "fileDeleted", path: "/old.ts", expectedContains: "Delete /old.ts" },
		{ tool: "listFilesTopLevel", path: "/src", expectedContains: "List /src" },
		{ tool: "listFilesRecursive", path: "/src", expectedContains: "List /src" },
		{ tool: "searchFiles", regex: "TODO", expectedContains: "Search TODO" },
	]

	titleCases.forEach(({ tool, path, regex, expectedContains }) => {
		it(`should build title for ${tool} containing "${expectedContains}"`, () => {
			const toolInfo = { tool, path, regex }
			const message = createDiracMessage({
				type: "say",
				say: "tool",
				text: JSON.stringify(toolInfo),
			})

			const result = translateMessage(message, sessionState)
			const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
				sessionUpdate: "tool_call"
			}

			expect(toolCall.title.toLowerCase()).toContain(expectedContains.toLowerCase())
		})
	})

	it("should use regular tool titles even when MCP-style identifiers are present", () => {
		const toolInfo = {
			tool: "readFile",
			serverName: "serena",
			toolName: "activate_project",
			path: "/repo",
		}
		const message = createDiracMessage({
			type: "say",
			say: "tool",
			text: JSON.stringify(toolInfo),
		})

		const result = translateMessage(message, sessionState)
		const toolCall = result.updates.find((u) => u.sessionUpdate === "tool_call") as acp.ToolCall & {
			sessionUpdate: "tool_call"
		}

		expect(toolCall.title).toBe("Read /repo")
	})
})

// =============================================================================
// Tests: Session State Management
// =============================================================================

describe("session state management", () => {
	let sessionState: AcpSessionState

	beforeEach(() => {
		sessionState = createTestSessionState()
	})

	it("should set currentToolCallId when creating a new tool call", () => {
		const message = createDiracMessage({
			type: "say",
			say: "command",
			text: "npm test",
		})

		expect(sessionState.currentToolCallId).toBeUndefined()

		translateMessage(message, sessionState)

		expect(sessionState.currentToolCallId).toBeDefined()
	})

	it("should clear currentToolCallId when tool completes", () => {
		sessionState.currentToolCallId = "test-tool-123"

		const message = createDiracMessage({
			type: "say",
			say: "command_output",
			text: "Done",
			commandCompleted: true,
		})

		translateMessage(message, sessionState)

		expect(sessionState.currentToolCallId).toBeUndefined()
	})

	it("should clear currentToolCallId on error", () => {
		sessionState.currentToolCallId = "test-tool-456"

		const message = createDiracMessage({
			type: "say",
			say: "error",
			text: "Something went wrong",
		})

		translateMessage(message, sessionState)

		expect(sessionState.currentToolCallId).toBeUndefined()
	})

	it("should track pending tool calls for permission requests", () => {
		const message = createDiracMessage({
			type: "ask",
			ask: "command",
			text: "rm -rf /",
		})

		translateMessage(message, sessionState)

		expect(sessionState.pendingToolCalls.size).toBe(1)
	})
})
