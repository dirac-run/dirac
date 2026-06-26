import "should"
import { CardStatus, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { expect } from "chai"
import sinon from "sinon"
import { ResponseProcessor } from "../ResponseProcessor"
import { StreamResponseHandler } from "../StreamResponseHandler"
import { TaskState } from "../TaskState"

const baseMetrics = { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 5, cacheReadTokens: 3, totalCost: 0.01 }

// Characterization tests for ResponseProcessor — verifies assistant response
// processing: stream consumption, tool call extraction, text extraction, error
// handling, empty-response retry, presentation locking, and content sanitization.
describe("ResponseProcessor", () => {
	let deps: any
	let processor: ResponseProcessor
	let taskState: TaskState
	let streamHandler: StreamResponseHandler
	let sessionModule: any
	let origUpdateToolCall: any

	beforeEach(() => {
		taskState = new TaskState()
		streamHandler = new StreamResponseHandler()
		deps = createMockDeps(taskState, streamHandler)
		processor = new ResponseProcessor(deps)
		// Stub Session.updateToolCall
		sessionModule = require("@shared/services/Session")
		origUpdateToolCall = sessionModule.Session.get
		sessionModule.Session.get = () => ({ updateToolCall: () => {} }) as any
	})

	afterEach(() => {
		sessionModule.Session.get = origUpdateToolCall
		sinon.restore()
	})

	describe("resetStreamState", () => {
		it("clears all streaming state fields", () => {
			processor.resetStreamState()
			// Verify no throw and state is clean
			expect(deps.taskState.assistantMessageContent).to.have.length(0)
		})
	})

	describe("consumeStream — text extraction", () => {
		it("accumulates text chunks into assistantMessage and assistantTextOnly", async () => {
			const chunks = [
				{ type: "text", id: "t1", text: "Hello ", signature: undefined },
				{ type: "text", id: "t1", text: "World", signature: undefined },
			]
			const coordinator = createCoordinator(chunks)
			const result = await processor.consumeStream(coordinator, createCallbacks())
			result.assistantMessage.should.equal("Hello World")
			result.assistantTextOnly.should.equal("Hello World")
			result.assistantMessageId.should.equal("t1")
		})

		it("preserves signature from text chunk", async () => {
			const chunks = [{ type: "text", id: "t1", text: "signed", signature: "sig-abc" }]
			const coordinator = createCoordinator(chunks)
			const result = await processor.consumeStream(coordinator, createCallbacks())
			result.assistantTextSignature!.should.equal("sig-abc")
		})

		it("overwrites signature with latest chunk signature", async () => {
			const chunks = [
				{ type: "text", id: "t1", text: "first", signature: "sig1" },
				{ type: "text", id: "t1", text: " second", signature: "sig2" },
			]
			const coordinator = createCoordinator(chunks)
			const result = await processor.consumeStream(coordinator, createCallbacks())
			result.assistantTextSignature!.should.equal("sig2")
		})

		it("uses last chunk id when ids differ", async () => {
			const chunks = [
				{ type: "text", id: "t1", text: "A", signature: undefined },
				{ type: "text", id: "t2", text: "B", signature: undefined },
			]
			const coordinator = createCoordinator(chunks)
			const result = await processor.consumeStream(coordinator, createCallbacks())
			result.assistantMessageId.should.equal("t2")
		})

		it("sets taskFirstTokenTimeMs on first chunk", async () => {
			taskState.taskStartTimeMs = Date.now() - 100
			const chunks = [{ type: "text", id: "t1", text: "x", signature: undefined }]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			taskState.taskFirstTokenTimeMs!.should.be.greaterThanOrEqual(0)
		})

		it("does not overwrite taskFirstTokenTimeMs if already set", async () => {
			taskState.taskFirstTokenTimeMs = 42
			const chunks = [{ type: "text", id: "t1", text: "x", signature: undefined }]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			taskState.taskFirstTokenTimeMs!.should.equal(42)
		})

		it("finalizes reasoning before first text when reasoning is pending", async () => {
			streamHandler.processReasoningDelta({ id: "r1", reasoning: "thinking..." })
			const finalizeStub = sinon.stub().resolves(true)
			const chunks = [{ type: "text", id: "t1", text: "answer", signature: undefined }]
			const coordinator = createCoordinator(chunks)
			const result = await processor.consumeStream(coordinator, {
				...createCallbacks(),
				finalizePendingReasoningMessage: finalizeStub,
			})
			sinon.assert.calledOnce(finalizeStub)
			finalizeStub.firstCall.args[0].should.equal("thinking...")
			result.didFinalizeReasoningForUi.should.be.true()
		})

		it("does not finalize reasoning twice", async () => {
			streamHandler.processReasoningDelta({ id: "r1", reasoning: "thinking..." })
			const finalizeStub = sinon.stub().resolves(true)
			const chunks = [
				{ type: "text", id: "t1", text: "a", signature: undefined },
				{ type: "text", id: "t1", text: "b", signature: undefined },
			]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, { ...createCallbacks(), finalizePendingReasoningMessage: finalizeStub })
			sinon.assert.calledOnce(finalizeStub)
		})

		it("does not set didFinalizeReasoningForUi when finalize returns false", async () => {
			streamHandler.processReasoningDelta({ id: "r1", reasoning: "thinking..." })
			const finalizeStub = sinon.stub().resolves(false)
			const chunks = [{ type: "text", id: "t1", text: "answer", signature: undefined }]
			const coordinator = createCoordinator(chunks)
			const result = await processor.consumeStream(coordinator, {
				...createCallbacks(),
				finalizePendingReasoningMessage: finalizeStub,
			})
			result.didFinalizeReasoningForUi.should.be.false()
		})
	})

	describe("consumeStream — tool call extraction", () => {
		it("processes tool_calls chunks and maps call_id to function id", async () => {
			const chunks = [
				{
					type: "tool_calls",
					tool_call: {
						function: { id: "func-1", name: "read_file", arguments: '{"path":"/test"}' },
						call_id: "call-1",
					},
					signature: undefined,
				},
			]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			taskState.toolUseIdMap.get("call-1")!.should.equal("func-1")
		})

		it("does not map call_id when function id is missing", async () => {
			const chunks = [
				{
					type: "tool_calls",
					tool_call: { function: { name: "read_file", arguments: "{}" }, call_id: "call-1" },
					signature: undefined,
				},
			]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			taskState.toolUseIdMap.has("call-1").should.be.false()
		})

		it("does not map call_id when call_id is missing", async () => {
			const chunks = [
				{
					type: "tool_calls",
					tool_call: { function: { id: "func-1", name: "read_file", arguments: "{}" } },
					signature: undefined,
				},
			]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			taskState.toolUseIdMap.size.should.equal(0)
		})

		it("creates tool_use block in assistantMessageContent via syncStreamState", async () => {
			const chunks = [
				{
					type: "tool_calls",
					tool_call: {
						function: { id: "func-1", name: "read_file", arguments: '{"path":"/test"}' },
						call_id: "call-1",
					},
					signature: undefined,
				},
			]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			const toolBlocks = taskState.assistantMessageContent.filter((b: any) => b.type === "tool_use")
			toolBlocks.should.have.length(1)
			const toolBlock = toolBlocks[0] as any
			toolBlock.name.should.equal("read_file") // eslint-disable-line
		})
	})

	describe("consumeStream — reasoning chunks", () => {
		it("processes reasoning delta and normalizes details to array", async () => {
			const chunks = [
				{
					type: "reasoning",
					id: "r1",
					reasoning: "I think...",
					signature: "sig",
					details: { type: "summary", summary: "text" },
					redacted_data: undefined,
				},
			]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			// Reasoning block should appear in assistantMessageContent
			const reasoningBlocks = taskState.assistantMessageContent.filter((b: any) => b.type === "reasoning")
			reasoningBlocks.should.have.length(1)
			const reasoningBlock = reasoningBlocks[0] as any
			reasoningBlock.reasoning.should.equal("I think...")
		})

		it("handles undefined details gracefully", async () => {
			const chunks = [
				{
					type: "reasoning",
					id: "r1",
					reasoning: "think",
					signature: undefined,
					details: undefined,
					redacted_data: undefined,
				},
			]
			const coordinator = createCoordinator(chunks)
			await processor.consumeStream(coordinator, createCallbacks())
			const reasoningBlocks = taskState.assistantMessageContent.filter((b: any) => b.type === "reasoning")
			reasoningBlocks.should.have.length(1)
		})
	})

	describe("consumeStream — abort handling", () => {
		it("interrupts stream and calls apiAbort when abort is set", async () => {
			const chunks = [{ type: "text", id: "t1", text: "partial", signature: undefined }]
			const coordinator = createCoordinator(chunks, () => {
				taskState.abort = true
			})
			const apiAbort = sinon.spy()
			const abortStream = sinon.stub().resolves()
			await processor.consumeStream(coordinator, { ...createCallbacks(), apiAbort, abortStream })
			sinon.assert.calledOnce(apiAbort)
			sinon.assert.calledOnce(abortStream)
			sinon.assert.calledWith(abortStream, "user_cancelled")
		})

		it("does not call abortStream when abandoned is true", async () => {
			const chunks = [{ type: "text", id: "t1", text: "partial", signature: undefined }]
			const coordinator = createCoordinator(chunks, () => {
				taskState.abort = true
				taskState.abandoned = true
			})
			const apiAbort = sinon.spy()
			const abortStream = sinon.stub().resolves()
			const result = await processor.consumeStream(coordinator, { ...createCallbacks(), apiAbort, abortStream })
			sinon.assert.calledOnce(apiAbort)
			sinon.assert.notCalled(abortStream)
			result.shouldInterruptStream.should.be.true()
		})

		it("appends interrupt marker and sets shouldInterruptStream when didRejectTool", async () => {
			const chunks = [{ type: "text", id: "t1", text: "partial", signature: undefined }]
			const coordinator = createCoordinator(chunks, () => {
				taskState.didRejectTool = true
			})
			const result = await processor.consumeStream(coordinator, createCallbacks())
			result.assistantMessage.should.containEql("[Response interrupted by user feedback]")
			result.shouldInterruptStream.should.be.true()
		})
	})

	describe("consumeStream — empty stream", () => {
		it("returns empty strings when no chunks", async () => {
			const coordinator = createCoordinator([])
			const result = await processor.consumeStream(coordinator, createCallbacks())
			result.assistantMessage.should.equal("")
			result.assistantTextOnly.should.equal("")
			result.assistantMessageId.should.equal("")
			result.shouldInterruptStream.should.be.false()
		})
	})

	describe("routeAssistantResponse", () => {
		it("returns false when no content and no message", async () => {
			const result = await processor.routeAssistantResponse(
				createRouteParams({ assistantMessage: "", assistantTextOnly: "" }),
			)
			result.should.be.false()
		})

		it("returns true when assistantMessage has content", async () => {
			const result = await processor.routeAssistantResponse(
				createRouteParams({ assistantMessage: "hello", assistantTextOnly: "hello" }),
			)
			result.should.be.true()
		})

		it("captures telemetry turn event when content exists", async () => {
			// Telemetry is fire-and-forget via async proxy — verify the content path was entered
			// by checking addToApiConversationHistory was called (only happens when content exists)
			streamHandler.processTextDelta({ id: "t1", text: "hello" })
			await processor.routeAssistantResponse(createRouteParams({ assistantMessage: "hello", assistantTextOnly: "hello" }))
			sinon.assert.calledOnce(deps.messageStateHandler.addToApiConversationHistory)
		})

		it("does not capture telemetry when no content", async () => {
			// No content → no telemetry → no history addition
			await processor.routeAssistantResponse(createRouteParams({ assistantMessage: "", assistantTextOnly: "" }))
			sinon.assert.notCalled(deps.messageStateHandler.addToApiConversationHistory)
		})

		it("adds to API conversation history when ordered blocks exist", async () => {
			streamHandler.processTextDelta({ id: "t1", text: "block content" })
			await processor.routeAssistantResponse(
				createRouteParams({ assistantMessage: "block content", assistantTextOnly: "block content" }),
			)
			sinon.assert.calledOnce(deps.messageStateHandler.addToApiConversationHistory)
			const callArgs = deps.messageStateHandler.addToApiConversationHistory.firstCall.args[0]
			callArgs.role.should.equal("assistant")
		})

		it("sets didCompleteReadingStream to true", async () => {
			await processor.routeAssistantResponse(createRouteParams({ assistantMessage: "x", assistantTextOnly: "x" }))
			taskState.didCompleteReadingStream.should.be.true()
		})

		it("throws pending presentation error if one occurred during streaming", async () => {
			// Simulate a pending error
			;(processor as any).pendingPresentationError = new Error("presentation failed")
			try {
				await processor.routeAssistantResponse(createRouteParams({ assistantMessage: "x", assistantTextOnly: "x" }))
				expect.fail("should have thrown")
			} catch (e: any) {
				e.message.should.equal("presentation failed")
			}
			// Error should be cleared after throw
			expect((processor as any).pendingPresentationError).to.be.undefined
		})
	})

	describe("handleEmptyAssistantResponse", () => {
		it("creates error card and auto-retries when attempts < 3", async () => {
			// Stub setTimeout to avoid real delay
			const timersModule = require("node:timers/promises")
			const origSetTimeout = timersModule.setTimeout
			timersModule.setTimeout = async () => {}
			try {
				const result = await processor.handleEmptyAssistantResponse(createEmptyParams())
				result.should.be.false() // retry requested
				taskState.emptyResponseRetryAttempts.should.equal(1)
				sinon.assert.calledTwice(deps.taskMessenger.createCard) // error card + retry card
			} finally {
				timersModule.setTimeout = origSetTimeout
			}
		})

		it("increments retry attempts exponentially", async () => {
			const timersModule = require("node:timers/promises")
			const origSetTimeout = timersModule.setTimeout
			timersModule.setTimeout = async () => {}
			try {
				await processor.handleEmptyAssistantResponse(createEmptyParams())
				taskState.emptyResponseRetryAttempts.should.equal(1)
				await processor.handleEmptyAssistantResponse(createEmptyParams())
				taskState.emptyResponseRetryAttempts.should.equal(2)
				await processor.handleEmptyAssistantResponse(createEmptyParams())
				taskState.emptyResponseRetryAttempts.should.equal(3)
			} finally {
				timersModule.setTimeout = origSetTimeout
			}
		})

		it("asks user for manual retry when attempts >= 3 and user approves", async () => {
			taskState.emptyResponseRetryAttempts = 3
			const cardHandle = {
				waitForInteraction: sinon.stub().resolves({ response: DiracAskResponse.APPROVE }),
				finalize: sinon.stub().resolves(),
			}
			deps.taskMessenger.createCard = sinon.stub().resolves(cardHandle)
			const result = await processor.handleEmptyAssistantResponse(createEmptyParams())
			result.should.be.false() // retry
			taskState.emptyResponseRetryAttempts.should.equal(0) // reset on approve
		})

		it("returns true when user rejects manual retry", async () => {
			taskState.emptyResponseRetryAttempts = 3
			const cardHandle = {
				waitForInteraction: sinon.stub().resolves({ response: DiracAskResponse.REJECT }),
				finalize: sinon.stub().resolves(),
			}
			deps.taskMessenger.createCard = sinon.stub().resolves(cardHandle)
			const result = await processor.handleEmptyAssistantResponse(createEmptyParams())
			result.should.be.true()
		})

		it("captures provider api error with empty_assistant_message", async () => {
			// Telemetry is fire-and-forget — verify error card was created (proves error path entered)
			const timersModule = require("node:timers/promises")
			const origSetTimeout = timersModule.setTimeout
			timersModule.setTimeout = async () => {}
			try {
				await processor.handleEmptyAssistantResponse(createEmptyParams())
				const errorCardCall = deps.taskMessenger.createCard.firstCall.args[0]
				errorCardCall.header.should.equal("API Error")
				errorCardCall.status.should.equal(CardStatus.ERROR)
			} finally {
				timersModule.setTimeout = origSetTimeout
			}
		})

		it("includes request id in error text when available", async () => {
			deps.getApiRequestIdSafe = () => "req-123"
			const timersModule = require("node:timers/promises")
			const origSetTimeout = timersModule.setTimeout
			timersModule.setTimeout = async () => {}
			try {
				await processor.handleEmptyAssistantResponse(createEmptyParams())
				const cardCall = deps.taskMessenger.createCard.firstCall.args[0]
				expect(cardCall.body).to.include("req-123")
			} finally {
				timersModule.setTimeout = origSetTimeout
			}
		})

		it("returns false and sets pending user message when user skips with ToolSkippedByUserMessage", async () => {
			const { ToolSkippedByUserMessage } = require("../tools/types/ToolSkippedByUserMessage")
			taskState.emptyResponseRetryAttempts = 3
			const skipError = new ToolSkippedByUserMessage("user msg", ["img"], ["file"])
			const cardHandle = { waitForInteraction: sinon.stub().rejects(skipError), finalize: sinon.stub().resolves() }
			deps.taskMessenger.createCard = sinon.stub().resolves(cardHandle)
			const result = await processor.handleEmptyAssistantResponse(createEmptyParams())
			result.should.be.false()
			taskState.pendingUserMessage!.should.equal("user msg")
			expect(taskState.pendingUserImages).to.deep.equal(["img"])
			expect(taskState.pendingUserFiles).to.deep.equal(["file"])
		})

		it("re-throws non-ToolSkippedByUserMessage errors from waitForInteraction", async () => {
			taskState.emptyResponseRetryAttempts = 3
			const cardHandle = {
				waitForInteraction: sinon.stub().rejects(new Error("unexpected")),
				finalize: sinon.stub().resolves(),
			}
			deps.taskMessenger.createCard = sinon.stub().resolves(cardHandle)
			try {
				await processor.handleEmptyAssistantResponse(createEmptyParams())
				expect.fail("should have thrown")
			} catch (e: any) {
				e.message.should.equal("unexpected")
			}
		})
	})

	describe("presentAssistantMessage — locking", () => {
		it("throws when abort is set during presentation", async () => {
			taskState.assistantMessageContent = [{ type: "text", content: "hello", isComplete: true } as any]
			taskState.abort = true
			try {
				await processor.presentAssistantMessage()
				expect.fail("should have thrown")
			} catch (e: any) {
				e.message.should.equal("Dirac instance aborted")
			}
		})

		it("processes text block and streams delta to assistantStreamManager", async () => {
			taskState.assistantMessageContent = [{ type: "text", content: "hello world", isComplete: true, call_id: "t1" } as any]
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			sinon.assert.called(deps.assistantStreamManager.handleChunk)
			const firstCall = deps.assistantStreamManager.handleChunk.firstCall.args
			firstCall[0].should.equal("hello world")
			firstCall[1].should.equal("text")
		})

		it("processes reasoning block and streams reasoning delta", async () => {
			taskState.assistantMessageContent = [
				{ type: "reasoning", reasoning: "deep thought", isComplete: true, call_id: "r1" } as any,
			]
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			sinon.assert.calledWith(deps.assistantStreamManager.handleChunk, "deep thought", "reasoning")
		})

		it("executes tool_use block via toolExecutor", async () => {
			taskState.assistantMessageContent = [
				{ type: "tool_use", name: "read_file", params: { path: "/x" }, isComplete: true, call_id: "call-1" } as any,
			]
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			sinon.assert.calledOnce(deps.toolExecutor.executeTool)
			const blockArg = deps.toolExecutor.executeTool.firstCall.args[0]
			blockArg.name.should.equal("read_file")
		})

		it("sets status to STREAMING_TEXT for incomplete text block", async () => {
			taskState.assistantMessageContent = [{ type: "text", content: "partial", isComplete: false, call_id: "t1" } as any]
			taskState.isApiRequestActive = true
			await processor.presentAssistantMessage()
			taskState.status.should.equal(TaskStatus.STREAMING_TEXT)
		})

		it("sets status to THINKING for incomplete reasoning block", async () => {
			taskState.assistantMessageContent = [
				{ type: "reasoning", reasoning: "partial", isComplete: false, call_id: "r1" } as any,
			]
			taskState.isApiRequestActive = true
			await processor.presentAssistantMessage()
			taskState.status.should.equal(TaskStatus.THINKING)
		})

		it("sets status to BUILDING_TOOL_CALL for incomplete tool_use", async () => {
			taskState.assistantMessageContent = [
				{ type: "tool_use", name: "read_file", params: {}, isComplete: false, call_id: "c1" } as any,
			]
			taskState.isApiRequestActive = true
			await processor.presentAssistantMessage()
			taskState.status.should.equal(TaskStatus.BUILDING_TOOL_CALL)
		})

		it("sets status to EXECUTING_TOOL for complete tool_use", async () => {
			taskState.assistantMessageContent = [
				{ type: "tool_use", name: "read_file", params: {}, isComplete: true, call_id: "c1" } as any,
			]
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			taskState.status.should.equal(TaskStatus.EXECUTING_TOOL)
		})

		it("skips text block streaming when didRejectTool is true", async () => {
			taskState.assistantMessageContent = [{ type: "text", content: "hello", isComplete: true, call_id: "t1" } as any]
			taskState.didRejectTool = true
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			sinon.assert.notCalled(deps.assistantStreamManager.handleChunk)
		})

		it("sets userMessageContentReady when all blocks processed and stream complete", async () => {
			taskState.assistantMessageContent = [{ type: "text", content: "done", isComplete: true, call_id: "t1" } as any]
			taskState.isApiRequestActive = false
			taskState.didCompleteReadingStream = true
			await processor.presentAssistantMessage()
			taskState.userMessageContentReady.should.be.true()
		})

		it("awaits initialCheckpointCommitPromise for non-read-only tools", async () => {
			const checkpointPromise = Promise.resolve("hash")
			taskState.initialCheckpointCommitPromise = checkpointPromise
			taskState.assistantMessageContent = [
				{ type: "tool_use", name: "write_file", params: {}, isComplete: true, call_id: "c1" } as any,
			]
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			// Promise should be consumed and cleared
			expect(taskState.initialCheckpointCommitPromise).to.be.undefined
		})

		it("does not await checkpoint for read-only tools", async () => {
			const checkpointPromise = Promise.resolve("hash")
			taskState.initialCheckpointCommitPromise = checkpointPromise
			taskState.assistantMessageContent = [
				{ type: "tool_use", name: "read_file", params: {}, isComplete: true, call_id: "c1" } as any,
			]
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			// Promise should remain for read-only tools
			expect(taskState.initialCheckpointCommitPromise).to.equal(checkpointPromise)
		})
	})

	describe("syncStreamState", () => {
		it("parses text blocks into AssistantMessageContent", async () => {
			streamHandler.processTextDelta({ id: "t1", text: "hello world" })
			await processor.syncStreamState("hello world")
			taskState.assistantMessageContent.should.have.length(1)
			taskState.assistantMessageContent[0].type.should.equal("text")
			;(taskState.assistantMessageContent[0] as any).content.should.equal("hello world")
		})

		it("parses reasoning tags embedded in text", async () => {
			streamHandler.processTextDelta({ id: "t1", text: "<thinking>reasoning here</thinking>after" })
			await processor.syncStreamState("text")
			const types = taskState.assistantMessageContent.map((b: any) => b.type)
			expect(types).to.include("reasoning")
			expect(types).to.include("text")
		})

		it("marks blocks as complete when isStreamComplete is true", async () => {
			streamHandler.processTextDelta({ id: "t1", text: "hello" })
			await processor.syncStreamState("hello", [], true)
			;(taskState.assistantMessageContent[0] as any).isComplete.should.be.true()
		})

		it("creates tool_use block from tool_use ordered block", async () => {
			streamHandler.processToolUseDelta({ id: "tu1", name: "read_file", input: '{"path":"/x"}' }, "call-1")
			await processor.syncStreamState("")
			const toolBlocks = taskState.assistantMessageContent.filter((b: any) => b.type === "tool_use")
			toolBlocks.should.have.length(1)
			const nativeToolBlock = toolBlocks[0] as any
			nativeToolBlock.isNativeToolCall.should.be.true()
			nativeToolBlock.call_id.should.equal("call-1")
		})

		it("sets userMessageContentReady to false when content grows", async () => {
			taskState.userMessageContentReady = true
			streamHandler.processTextDelta({ id: "t1", text: "new content" })
			await processor.syncStreamState("new content")
			taskState.userMessageContentReady.should.be.false()
		})

		it("sets userMessageContentReady to false when toolBlocks exist", async () => {
			taskState.userMessageContentReady = true
			await processor.syncStreamState("", [{ id: "tu1", name: "test", input: {}, call_id: "c1", isComplete: false } as any])
			taskState.userMessageContentReady.should.be.false()
		})

		it("handles empty ordered blocks", async () => {
			await processor.syncStreamState("")
			taskState.assistantMessageContent.should.have.length(0)
		})
	})

	describe("sanitizeModelQuirks", () => {
		it("removes <function_calls> tags", () => {
			const result = (processor as any).sanitizeModelQuirks("<function_calls>some content</function_calls>")
			result.should.equal("some content")
		})

		it("removes <function_calls> with optional space", () => {
			const result = (processor as any).sanitizeModelQuirks("<function_calls> content </function_calls>")
			result.should.equal("content")
		})

		it("trims incomplete opening tag at end", () => {
			const result = (processor as any).sanitizeModelQuirks("hello <func")
			result.should.equal("hello")
		})

		it("trims incomplete closing tag at end", () => {
			const result = (processor as any).sanitizeModelQuirks("hello </func")
			result.should.equal("hello")
		})

		it("trims lone opening bracket", () => {
			const result = (processor as any).sanitizeModelQuirks("hello <")
			result.should.equal("hello")
		})

		it("trims lone closing bracket prefix", () => {
			const result = (processor as any).sanitizeModelQuirks("hello </")
			result.should.equal("hello")
		})

		it("does not trim complete tag with closing bracket", () => {
			const result = (processor as any).sanitizeModelQuirks("hello <tag>world")
			result.should.equal("hello <tag>world")
		})

		it("does not trim non-tag-like bracket content", () => {
			const result = (processor as any).sanitizeModelQuirks("hello < 123")
			result.should.equal("hello < 123")
		})

		it("preserves content with no tags", () => {
			const result = (processor as any).sanitizeModelQuirks("just plain text")
			result.should.equal("just plain text")
		})

		it("handles empty string", () => {
			const result = (processor as any).sanitizeModelQuirks("")
			result.should.equal("")
		})

		it("only trims tag-like content after last bracket", () => {
			const result = (processor as any).sanitizeModelQuirks("<tag>complete</tag>incomplete <brok")
			result.should.equal("<tag>complete</tag>incomplete")
		})
	})

	describe("presentAssistantMessage — code fence trimming", () => {
		it("trims trailing unclosed code fence from complete text block", async () => {
			taskState.assistantMessageContent = [
				{ type: "text", content: "code\n```python", isComplete: true, call_id: "t1" } as any,
			]
			taskState.isApiRequestActive = false
			await processor.presentAssistantMessage()
			const streamedContent = deps.assistantStreamManager.handleChunk.firstCall.args[0]
			expect(streamedContent).to.not.include("```python")
		})

		it("does not trim code fence from incomplete text block", async () => {
			taskState.assistantMessageContent = [
				{ type: "text", content: "code\n```python", isComplete: false, call_id: "t1" } as any,
			]
			taskState.isApiRequestActive = true
			await processor.presentAssistantMessage()
			// Incomplete block: content streamed as-is (delta from lastProcessedContentLength)
			sinon.assert.called(deps.assistantStreamManager.handleChunk)
		})
	})
})

// --- Helpers ---

function createMockDeps(taskState: TaskState, streamHandler: StreamResponseHandler): any {
	return {
		taskState,
		streamHandler,
		messageStateHandler: { addToApiConversationHistory: sinon.stub().resolves() },
		taskMessenger: {
			createCard: sinon.stub().resolves({
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ response: DiracAskResponse.APPROVE }),
			}),
		},
		assistantStreamManager: { handleChunk: sinon.stub().resolves(), pauseForToolCall: sinon.stub().resolves() },
		toolExecutor: { executeTool: sinon.stub().resolves() },
		postStateToWebview: sinon.stub().resolves(),
		ulid: "test-ulid",
		taskId: "test-task-id",
		getApiRequestIdSafe: () => undefined,
	}
}

function createCallbacks(): any {
	return {
		abortStream: sinon.stub().resolves(),
		finalizePendingReasoningMessage: sinon.stub().resolves(true),
		apiAbort: sinon.spy(),
	}
}

function createRouteParams(overrides: Partial<any> = {}): any {
	return {
		assistantMessage: "hello",
		assistantTextOnly: "hello",
		assistantTextSignature: undefined,
		assistantMessageId: "t1",
		providerId: "anthropic",
		modelId: "model-1",
		mode: "act",
		taskMetrics: baseMetrics,
		modelInfo: { id: "model-1" },
		toolUseHandler: { getParsedToolUseStates: () => [] },
		...overrides,
	}
}

function createEmptyParams(): any {
	return {
		modelInfo: { id: "model-1" },
		taskMetrics: baseMetrics,
		providerId: "anthropic",
		model: { id: "model-1" },
	}
}

// Creates a StreamChunkCoordinator-like object that yields chunks sequentially.
// onChunk callback is called after each chunk is dequeued (for side effects like setting abort).
function createCoordinator(chunks: any[], onChunk?: () => void): any {
	let index = 0
	return {
		async nextChunk(): Promise<any> {
			if (index < chunks.length) {
				const chunk = chunks[index++]
				if (onChunk) onChunk()
				return chunk
			}
			return undefined
		},
	}
}
