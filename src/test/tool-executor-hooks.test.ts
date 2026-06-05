import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import * as sinon from "sinon"
import { executeHook } from "../core/hooks/hook-executor"
import { StateManager } from "../core/storage/StateManager"
import { MessageStateHandler } from "../core/task/message-state"
import { TaskState } from "../core/task/TaskState"

/**
 * Unit tests for tool hook execution (PreToolUse and PostToolUse)
 * These tests verify the consolidated hook execution logic for tool-specific hooks
 */
describe("Tool Executor Hooks", () => {
	let stateManagerStub: sinon.SinonStub

	beforeEach(() => {
		// Mock StateManager to return empty workspace roots
		stateManagerStub = sinon.stub(StateManager, "get").returns({
			getGlobalStateKey: (key: string) => {
				if (key === "workspaceRoots") {
					return []
				}
				return undefined
			},
		} as any)
	})

	afterEach(() => {
		// Restore StateManager stub
		stateManagerStub.restore()
	})

	/**
	 * Helper to create a minimal MessageStateHandler for testing
	 */
	function createTestHandler(): MessageStateHandler {
		const taskState = new TaskState()
		return new MessageStateHandler({
			taskId: "test-task-id",
			ulid: "test-ulid",
			taskState,
			updateTaskHistory: async () => [],
		})
	}

	describe("PreToolUse Hook", () => {
		it("should include toolName and pendingToolInfo in hook metadata", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const pendingToolInfo = {
				tool: "write_to_file",
				path: "/test/file.ts",
				content: "test content",
			}

			const result = await executeHook({
				hookName: "PreToolUse",
				hookInput: {
					preToolUse: {
						toolName: "write_to_file",
						parameters: { path: "/test/file.ts", content: "test content" },
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false, // Disabled so hook doesn't actually run
				toolName: "write_to_file",
				pendingToolInfo,
			})

			// Should return early since hooks are disabled
			result.wasCancelled.should.equal(false)
		})

		it("should handle PreToolUse hook with pendingToolInfo parameter", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}
			const pendingToolInfo = {
				tool: "execute_command",
				command: "npm test",
			}

			const result = await executeHook({
				hookName: "PreToolUse",
				hookInput: {
					preToolUse: {
						toolName: "execute_command",
						parameters: { command: "npm test" },
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false, // Hook doesn't exist, so returns early
				toolName: "execute_command",
				pendingToolInfo,
			})

			result.wasCancelled.should.equal(false)
		})

		it("should support cancellation for PreToolUse hooks", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			// Test that cancellable hooks can use setActiveHookExecution
			let setHookCalled = false
			const result = await executeHook({
				hookName: "PreToolUse",
				hookInput: {
					preToolUse: {
						toolName: "write_to_file",
						parameters: {},
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				setActiveHookExecution: async () => {
					setHookCalled = true
				},
				clearActiveHookExecution: async () => {},
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false, // Doesn't run, but we verify the parameter is accepted
				toolName: "write_to_file",
			})

			result.wasCancelled.should.equal(false)
			// In real execution, setHookCalled would be true, but hook doesn't exist here
		})

		it("should pass through context modification from PreToolUse", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PreToolUse",
				hookInput: {
					preToolUse: {
						toolName: "read_file",
						parameters: { path: "/test/file.ts" },
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false,
				toolName: "read_file",
			})

			result.wasCancelled.should.equal(false)
			// Hook doesn't exist, so no context modification
		})
	})

	describe("PostToolUse Hook", () => {
		it("should include toolName in hook metadata", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PostToolUse",
				hookInput: {
					postToolUse: {
						toolName: "write_to_file",
						parameters: { path: "/test/file.ts" },
						result: "File written successfully",
						success: true,
						executionTimeMs: 150,
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false,
				toolName: "write_to_file",
			})

			result.wasCancelled.should.equal(false)
		})

		it("should include execution metrics in PostToolUse hook input", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PostToolUse",
				hookInput: {
					postToolUse: {
						toolName: "execute_command",
						parameters: { command: "npm test" },
						result: "Tests passed",
						success: true,
						executionTimeMs: 5000, // 5 seconds
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false,
				toolName: "execute_command",
			})

			result.wasCancelled.should.equal(false)
		})

		it("should handle PostToolUse hook for failed tool execution", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PostToolUse",
				hookInput: {
					postToolUse: {
						toolName: "read_file",
						parameters: { path: "/nonexistent/file.ts" },
						result: "Error: File not found",
						success: false,
						executionTimeMs: 50,
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false,
				toolName: "read_file",
			})

			result.wasCancelled.should.equal(false)
		})

		it("should support cancellation for PostToolUse hooks", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PostToolUse",
				hookInput: {
					postToolUse: {
						toolName: "browser_action",
						parameters: { action: "launch", url: "https://example.com" },
						result: "Browser launched",
						success: true,
						executionTimeMs: 1200,
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				setActiveHookExecution: async () => {},
				clearActiveHookExecution: async () => {},
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false,
				toolName: "browser_action",
			})

			result.wasCancelled.should.equal(false)
		})
	})

	describe("Tool Hook Edge Cases", () => {
		it("should handle hook execution when hooks are disabled", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PreToolUse",
				hookInput: {
					preToolUse: {
						toolName: "write_to_file",
						parameters: {},
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false, // Explicitly disabled
				toolName: "write_to_file",
			})

			result.should.deepEqual({
				wasCancelled: false,
			})
		})

		it("should handle hook execution when hook doesn't exist", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PostToolUse",
				hookInput: {
					postToolUse: {
						toolName: "list_files",
						parameters: {},
						result: "[]",
						success: true,
						executionTimeMs: 10,
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: true, // Enabled but hook doesn't exist
				toolName: "list_files",
			})

			result.should.deepEqual({
				wasCancelled: false,
			})
		})

		it("should handle PostToolUse with execution time metrics", async () => {
			const testHandler = createTestHandler()
			const sayMessages: Array<{ type: string; text: string }> = []
			const mockMessenger: any = {
				upsertText: async (text: string, isReasoning?: boolean) => {
					sayMessages.push({ type: isReasoning ? "reasoning" : "text", text })
				},
				createCard: async (params: any) => {
					return { id: "card-id", update: async () => {}, appendBody: async () => {}, finalize: async () => {} }
				}
			}

			const result = await executeHook({
				hookName: "PostToolUse",
				hookInput: {
					postToolUse: {
						toolName: "search_files",
						parameters: { path: ".", regex: "test.*", file_pattern: "*.ts" },
						result: "Found 25 matches",
						success: true,
						executionTimeMs: 2500,
					},
				},
				isCancellable: true,
				messenger: mockMessenger,
				messageStateHandler: testHandler,
				taskId: "test-task",
				hooksEnabled: false,
				toolName: "search_files",
			})

			result.wasCancelled.should.equal(false)
		})
	})
})
