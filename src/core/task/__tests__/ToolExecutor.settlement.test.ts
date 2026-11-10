import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getSavedApiConversationState } from "@core/storage/conversationHistory"
import * as disk from "@core/storage/disk"
import { DiracError, ErrorService } from "@services/error"
import type { DiracContent } from "@shared/messages/content"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { MessageStateHandler } from "../message-state"
import { StreamingMetricsManager } from "../StreamingMetricsManager"
import * as requestAttempt from "../TaskApiRequestAttempt"
import { recursivelyMakeDiracRequests } from "../TaskRequestLoop"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { ToolUse } from "@core/assistant-message"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import * as HookExecutor from "@core/hooks/hook-executor"
import { ToolExecutor } from "../ToolExecutor"
import { ResponseProcessor } from "../ResponseProcessor"
import { createTaskRequestRuntime } from "../runtime/TaskRequestRuntime"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import { ToolExecutorCoordinator } from "../tools/ToolExecutorCoordinator"
import { createMockTaskConfig } from "../tools/__tests__/helpers/mockTaskConfig"
import type { IDiracTool } from "../tools/interfaces/IDiracTool"
import { ToolErrorHandler, ToolHookRunner } from "../tools/runtime/ToolHookRunner"
import { ToolInvocationSettlementError } from "../tools/runtime/ToolInvocationSettlementError"
import { ToolResultPusher } from "../tools/runtime/ToolResultPusher"
import { ToolSkippedByUserMessage } from "../tools/types/ToolSkippedByUserMessage"

function fixture(processCall: IDiracTool["processCall"] = async () => "completed operation", toolName = "read_file") {
	const mock = createMockTaskConfig({ overrides: { hooksEnabled: true } })
	const configuration = createTaskWorkingConfiguration({
		revision: 1,
		settings: { mode: "act", hooksEnabled: true } as any,
		apiConfiguration: { apiProvider: "anthropic" } as any,
		workspaceConfiguration: {} as any,
		executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false },
	})
	const runtime = createTaskRequestRuntime(configuration, { getModel: () => mock.config.model } as any, "request")
	const coordinator = new ToolExecutorCoordinator()
	coordinator.registerModularTool({
		spec: () => ({ id: toolName, name: toolName, description: "fixture" }),
		supportedSurfaces: () => ["all"],
		processCall,
	})
	mock.config.coordinator = coordinator
	const hookRunner = new ToolHookRunner(
		mock.config.messageState, mock.config.taskMessenger, "task",
		mock.callbacks.setActiveHookExecution, mock.callbacks.clearActiveHookExecution,
	)
	const executor = Object.assign(Object.create(ToolExecutor.prototype), {
		taskState: mock.taskState,
		coordinator,
		asToolConfig: () => mock.config,
		requestRuntime: () => runtime,
		getCurrentWorkingConfiguration: () => configuration,
		hookRunner,
		browserSession: { closeBrowser: sinon.stub().resolves() },
		resultPusher: new ToolResultPusher(mock.taskState),
		errorHandler: new ToolErrorHandler(mock.taskState, mock.config.taskMessenger),
	}) as ToolExecutor
	const push = sinon.spy((executor as any).resultPusher, "pushToolResult")
	const block = { type: "tool_use", id: "native-call", name: toolName, params: { paths: ["file"] }, isComplete: true } as ToolUse
	return { ...mock, executor, runtime, push, block }
}

function postHookFailure() {
	const failure = new HookCleanupError([new Error("resource still owned")], "Hook cleanup failed")
	const hooks = sinon.stub(HookExecutor, "executeHook").callsFake(async (options) => {
		if (options.hookName === "PostToolUse") throw failure
		return { wasCancelled: false, contextModification: "FILES: pre-hook context" }
	})
	return { failure, hooks }
}

describe("ToolExecutor operation results and hook settlement", () => {
	afterEach(() => sinon.restore())

	it("retains the operation result and effects on execution-only hook failure without writing a later turn", async () => {
		const { executor, config, taskState, block, runtime, push } = fixture()
		const { failure } = postHookFailure()
		taskState.userMessageContent = [{ type: "text", text: "later turn" }]
		taskState.consecutiveMistakeCount = 5
		await assert.rejects(() => (executor as any).runInvocation(block, config, runtime), (error: unknown) => {
			assert.ok(error instanceof ToolInvocationSettlementError)
			assert.equal(error.cause, failure)
			assert.match(error.message, /operation completed.*success.*hook settlement failed/)
			assert.equal(error.operationResult.outcome, "success")
			assert.equal(error.operationResult.content, "completed operation")
			assert.equal(error.operationResult.effects.mistake, "reset")
			const context = error.operationResult.effects.context![0]
			assert.ok(context.type === "text")
			assert.match(context.text, /pre-hook context/)
			return true
		})
		assert.deepEqual(taskState.userMessageContent, [{ type: "text", text: "later turn" }])
		assert.equal(taskState.consecutiveMistakeCount, 5)
		assert.equal(taskState.totalToolCallCount, 0)
		sinon.assert.notCalled(push)
	})

	it("commits successful tool content and context once before propagating fatal post-hook cleanup failure", async () => {
		const { executor, taskState, block, push, taskMessenger } = fixture()
		const { failure } = postHookFailure()
		taskState.consecutiveMistakeCount = 5
		await assert.rejects(() => executor.executeTool(block), (error: unknown) => error instanceof ToolInvocationSettlementError && error.cause === failure)
		assert.equal(taskState.consecutiveMistakeCount, 0)
		assert.equal(taskState.totalToolCallCount, 1)
		sinon.assert.calledOnceWithExactly(push, "completed operation", block)
		assert.equal(taskState.userMessageContent.filter((item) => item.type === "tool_result").length, 1)
		assert.match((taskState.userMessageContent[1] as any).text, /pre-hook context/)
		sinon.assert.notCalled(taskMessenger.createCard)
	})

	it("preserves user feedback and attachments when post-hook cleanup fails", async () => {
		const { executor, taskState, block, push } = fixture(async () => {
			throw new ToolSkippedByUserMessage("new feedback", ["image"], ["file"])
		})
		postHookFailure()
		taskState.consecutiveMistakeCount = 5
		await assert.rejects(() => executor.executeTool(block), ToolInvocationSettlementError)
		assert.equal(taskState.didRejectTool, true)
		assert.equal(taskState.pendingUserMessage, "new feedback")
		assert.deepEqual(taskState.pendingUserImages, ["image"])
		assert.deepEqual(taskState.pendingUserFiles, ["file"])
		assert.equal(taskState.consecutiveMistakeCount, 5)
		sinon.assert.calledOnce(push)
		assert.match(push.firstCall.args[0] as string, /new feedback/)
	})

	it("skips PostToolUse for an explicit pre-start veto and promptly commits task cancellation", async () => {
		const operation = sinon.stub().resolves("must not run")
		const { executor, block, push, callbacks } = fixture(operation)
		const hooks = sinon.stub(HookExecutor, "executeHook").resolves({ cancel: true, wasCancelled: false, errorMessage: "veto" })
		await executor.executeTool(block)
		sinon.assert.notCalled(operation)
		sinon.assert.calledOnce(hooks)
		assert.equal(hooks.firstCall.args[0].hookName, "PreToolUse")
		sinon.assert.calledOnce(push)
		sinon.assert.calledOnce(callbacks.cancelTask as sinon.SinonStub)
		sinon.assert.callOrder(push, callbacks.cancelTask as sinon.SinonStub)
	})

	it("does not suppress a fatal pre-hook ownership failure or invent a native result", async () => {
		const operation = sinon.stub().resolves("must not run")
		const { executor, block, push } = fixture(operation)
		const failure = new HookCleanupError([new Error("owned")], "Pre-hook cleanup failed")
		sinon.stub(HookExecutor, "executeHook").rejects(failure)
		await assert.rejects(() => executor.executeTool(block), (error) => error === failure)
		sinon.assert.notCalled(operation)
		sinon.assert.notCalled(push)
	})

	for (const phase of ["pre", "post", "persistence", "checkpoint", "completion", "completion-persistence", "continuation", "descendant", "preparation", "staged"] as const) {
		it(`persists exactly one native result per call across ${phase}, using disk reload`, async () => {
			if (phase !== "completion" && phase !== "continuation") expectLoggerErrors()
			sinon.stub(ErrorService, "get").returns({ toDiracError: DiracError.transform } as ErrorService)
			sinon.stub(requestAttempt, "attemptApiRequest").callsFake(async function* () { })
			sinon.stub(StreamingMetricsManager.prototype, "updateApiReqMsgFromMetrics").resolves()
			const operation = sinon.stub().resolves("completed operation")
			const { executor, taskState, block, runtime, push } = fixture(operation, phase === "checkpoint" ? "write_to_file" : "read_file")
			const interrupted = phase === "pre" || phase === "post" || phase === "persistence"
			if (phase === "pre") sinon.stub(HookExecutor, "executeHook").rejects(new HookCleanupError([], "Hook cleanup failed"))
			else if (interrupted) postHookFailure()
			else sinon.stub(HookExecutor, "executeHook").resolves({ wasCancelled: false })
			const blocks = interrupted ? [block, { ...block, id: "later-call", call_id: "later-provider-call" }] : [block]
			taskState.assistantMessageContent = blocks
			taskState.didAttemptCompletion = phase === "completion" || phase === "completion-persistence"
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-result-boundary-"))
			setVscodeHostProviderMock({ globalStorageFsPath: directory })
			const messages = new MessageStateHandler({ taskId: "task", ulid: "task", taskState, updateTaskHistory: async () => [] })
			const writeFailure = new Error("disk full")
			const append = disk.appendApiConversationOperations
			let failResults = phase === "persistence" || phase === "completion-persistence"
			sinon.stub(disk, "appendApiConversationOperations").callsFake(async (...args) => {
				if (failResults && args[1].some((op) => op.type === "append_message" && op.message.role === "user")) throw writeFailure
				return append(...args)
			})
			try {
				sinon.stub(messages, "saveDiracMessagesAndUpdateHistory").resolves()
				const streamHandler = {
					requestId: "request",
					getOrderedBlocks: () => blocks.map((call) => ({ type: "tool_use", id: call.id, call_id: call.call_id, name: call.name, input: call.params })),
					getHandlers: () => ({ toolUseHandler: { getParsedToolUseStates: () => blocks }, reasonsHandler: { getCurrentReasoning: () => undefined } }),
				}
				const processor = new ResponseProcessor({
					taskState, toolExecutor: executor, messageStateHandler: messages, streamHandler,
					assistantStreamManager: { pauseForToolCall: async () => { } }, postStateToWebview: async () => { },
				} as any)
				sinon.stub(processor, "consumeStream").resolves({
					assistantMessage: "", assistantTextOnly: "", assistantMessageId: "assistant",
					shouldInterruptStream: false, didFinalizeReasoningForUi: false,
				})
				const continuation: sinon.SinonStub = sinon.stub().callsFake(async (content: DiracContent[], includeDetails: boolean, acknowledge: () => void) => {
					const nextContext = {
						...context,
						apiConversationManager: {
							prepareApiRequest: async ({ userContent, afterUserContentPersisted }: { userContent: DiracContent[]; afterUserContentPersisted: () => Promise<void> }) => {
								if (phase === "preparation") {
									Object.assign(userContent[0], { content: "mutated during preparation" })
									taskState.resetStreamRead()
									taskState.userMessageContent = []
									throw new Error("preparation failed before append")
								}
								await messages.addToApiConversationHistory({ role: "user", content: userContent })
								if (phase === "staged") throw new Error("preparation failed after append")
								await afterUserContentPersisted()
								taskState.userMessageContent = [{ type: "tool_result", tool_use_id: "descendant-call", content: "later result" }]
								if (phase === "descendant") throw new Error("descendant failed")
								return { userContent, lastApiReqIndex: 0, didConsumeUserContent: true, isDirectResponse: true }
							},
						},
					}
					return recursivelyMakeDiracRequests(nextContext as any, content, includeDetails, acknowledge)
				})
				const context = {
					taskState, executionProfile: "tasklet", ulid: "task", requestRuntime: runtime,
					messageStateHandler: messages, responseProcessor: processor, streamHandler,
					modelContextTracker: { recordModelUsage: async () => { } },
					enqueuePreRequestSteeringMessages: async () => { },
					handleMistakeLimitReached: async (userContent: DiracContent[]) => ({ didEndLoop: false, userContent }),
					initializeCheckpoints: async () => { }, determineContextCompaction: async () => false,
					steeringContext: { taskState, withStateLock: async (callback: () => unknown) => callback() },
					apiConversationManager: { prepareApiRequest: async ({ userContent }: { userContent: DiracContent[] }) => ({ userContent, lastApiReqIndex: 0 }) },
					resetStreamingState: async () => { }, postStateToWebview: async () => { },
					diffViewProvider: { isEditing: false }, recursivelyMakeDiracRequests: continuation,
					checkpointManager: { saveCheckpoint: async () => { throw new Error("checkpoint failed") } },
				}
				const running = recursivelyMakeDiracRequests(context as any, [])
				if (phase === "completion" || phase === "continuation") assert.equal(await running, true)
				else if (phase === "persistence" || phase === "completion-persistence") {
					await assert.rejects(running, (error: unknown) => {
						if (phase === "completion-persistence") return error === writeFailure
						assert.ok(error instanceof AggregateError)
						assert.ok(error.errors[0] instanceof ToolInvocationSettlementError)
						assert.equal(error.errors[1], writeFailure)
						return true
					})
					assert.equal((await getSavedApiConversationState("task")).messages.length, 1)
					assert.equal(taskState.userMessageContent.filter((item) => item.type === "tool_result").length, 1)
					failResults = false
					await messages.flushPendingWrites() // Retry the append already queued, not another result message.
				} else await assert.rejects(running)
				assert.equal(operation.callCount, phase === "pre" ? 0 : 1)
				assert.equal(push.callCount, phase === "pre" ? 0 : 1)
				const reopened = (await getSavedApiConversationState("task")).messages
				assert.deepEqual(reopened.map((message) => message.role), ["assistant", "user"])
				const content = reopened[1].content
				assert.ok(Array.isArray(content))
				const results = content.filter((item) => item.type === "tool_result")
				assert.deepEqual(results.map((item) => item.tool_use_id), interrupted ? ["native-call", "later-call"] : ["native-call"])
				if (phase !== "pre") assert.equal(results[0].content, "completed operation")
				else assert.equal(results[0].is_error, true)
				if (interrupted) {
					assert.ok("call_id" in results[1])
					assert.equal(results[1].call_id, "later-provider-call")
					assert.equal(results[1].is_error, true)
					assert.match(String(results[1].content), /Effects may have occurred/)
				}
				assert.equal(continuation.callCount, ["continuation", "descendant", "preparation", "staged"].includes(phase) ? 1 : 0)
			} finally {
				failResults = false
				await messages.retirePersistence()
				HostProvider.reset()
				await fs.rm(directory, { recursive: true, force: true })
			}
		})
	}
})
