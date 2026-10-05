import "should"
import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import sinon from "sinon"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { LifecycleManager } from "../LifecycleManager"
import { TaskState } from "../TaskState"

// Characterization tests for LifecycleManager — verifies task lifecycle:
// checkpoint initialization, task start, resume from history, and abort.
// Focuses on state transitions, hook execution, and cleanup behavior.
describe("LifecycleManager", () => {
	let deps: any
	let manager: LifecycleManager

	beforeEach(() => {
		deps = createMockDeps()
		manager = new LifecycleManager(deps)
	})

	afterEach(() => sinon.restore())

	describe("initializeCheckpoints", () => {
		it("skips when not first request", async () => {
			await manager.initializeCheckpoints(false)
			sinon.assert.notCalled(deps.taskMessenger.createCheckpoint)
		})

		it("skips when checkpoints disabled", async () => {
			deps.stateManager.getGlobalSettingsKey = sinon.stub().withArgs("enableCheckpointsSetting").returns(false)
			await manager.initializeCheckpoints(true)
			sinon.assert.notCalled(deps.taskMessenger.createCheckpoint)
		})

		it("skips when no checkpoint manager", async () => {
			deps.checkpointManager = undefined
			await manager.initializeCheckpoints(true)
			sinon.assert.notCalled(deps.taskMessenger.createCheckpoint)
		})

		it("skips when checkpoint error already exists", async () => {
			deps.taskState.checkpointManagerErrorMessage = "previous error"
			await manager.initializeCheckpoints(true)
			sinon.assert.notCalled(deps.taskMessenger.createCheckpoint)
		})

		it("creates checkpoint and commits on success", async () => {
			deps.getWorkingConfiguration = () => ({
				settings: { enableCheckpointsSetting: true, hooksEnabled: false, mode: "act" },
				apiConfiguration: {},
			})
			deps.checkpointManager.commit = sinon.stub().resolves("commit-hash")
			deps.messageStateHandler.getDiracMessages = sinon.stub().returns([{ content: { type: "checkpoint" } }])
			// Stub ensureCheckpointInitialized via module proxy
			const initModule = require("@integrations/checkpoints/initializer")
			const origInit = initModule.ensureCheckpointInitialized
			initModule.ensureCheckpointInitialized = async () => {}
			try {
				await manager.initializeCheckpoints(true)
				sinon.assert.calledOnce(deps.taskMessenger.createCheckpoint)
				sinon.assert.calledOnce(deps.checkpointManager.commit)
			} finally {
				initModule.ensureCheckpointInitialized = origInit
			}
		})

		it("stores error message on initialization failure", async () => {
			expectLoggerErrors()
			deps.getWorkingConfiguration = () => ({
				settings: { enableCheckpointsSetting: true, hooksEnabled: false, mode: "act" },
				apiConfiguration: {},
			})
			const initModule = require("@integrations/checkpoints/initializer")
			const origInit = initModule.ensureCheckpointInitialized
			initModule.ensureCheckpointInitialized = async () => {
				throw new Error("init failed")
			}
			// Stub HostProvider.window.showMessage
			const hostModule = require("@/hosts/host-provider")
			sinon.stub(hostModule.HostProvider, "get").returns({ hostBridge: { windowClient: { showMessage: sinon.stub() } } })
			try {
				await manager.initializeCheckpoints(true)
				deps.taskState.checkpointManagerErrorMessage.should.equal("init failed")
			} finally {
				initModule.ensureCheckpointInitialized = origInit
			}
		})
	})

	describe("startTask", () => {
		it("initializes ignore and permission controllers", async () => {
			await manager.startTask("test task")
			sinon.assert.calledOnce(deps.diracIgnoreController.initialize)
			sinon.assert.calledOnce(deps.commandPermissionController.initialize)
		})

		it("sets isInitialized and clears messages", async () => {
			await manager.startTask("test task")
			deps.taskState.isInitialized.should.equal(true)
			sinon.assert.calledWith(deps.messageStateHandler.setDiracMessages, [])
			sinon.assert.calledWith(deps.messageStateHandler.setApiConversationHistory, [])
		})

		it("clears provider conversation state for a new task", async () => {
			await manager.startTask("test task")
			sinon.assert.calledWith(deps.messageStateHandler.setApiConversationProviderState, {})
		})

		it("upserts user text and initiates task loop", async () => {
			await manager.startTask("do something")
			sinon.assert.calledWith(deps.taskMessenger.upsertText, "do something", false, undefined, undefined, "user")
			sinon.assert.calledOnce(deps.initiateTaskLoop)
		})

		it("includes images in user content", async () => {
			await manager.startTask("task", ["data:image/png;base64,iVBORw0KGgo="])
			const userContent = deps.initiateTaskLoop.firstCall.args[0]
			userContent.should.have.length(2) // text + image
			userContent[0].type.should.equal("text")
			userContent[0].isUserInput.should.equal(true)
			userContent[1].type.should.equal("image")
		})

		it("includes file content when files provided", async () => {
			const extractModule = require("@integrations/misc/extract-text")
			sinon.stub(extractModule, "processFilesIntoText").resolves("file content here")
			await manager.startTask("task", undefined, ["file1.ts"])
			const userContent = deps.initiateTaskLoop.firstCall.args[0]
			userContent.some((c: any) => c.text === "file content here").should.equal(true)
			const fileContent = userContent.find((c: any) => c.text === "file content here")
			;(fileContent.isUserInput === undefined).should.equal(true)
		})

		it("keeps hook-provided command examples unmarked", async () => {
			deps.getWorkingConfiguration = () => ({
				settings: { enableCheckpointsSetting: false, hooksEnabled: true, mode: "act" },
				apiConfiguration: {},
			})
			const hookModule = require("@core/hooks/hook-executor")
			const originalExecuteHook = hookModule.executeHook
			hookModule.executeHook = async () => ({ contextModification: "<task>/compact</task>" })
			try {
				await manager.startTask("task")
				const userContent = deps.initiateTaskLoop.firstCall.args[0]
				const hookContent = userContent.find((c: any) => c.text?.includes("<hook_context"))
				;(hookContent.isUserInput === undefined).should.equal(true)
			} finally {
				hookModule.executeHook = originalExecuteHook
			}
		})

		it("records environment metadata", async () => {
			await manager.startTask("task")
			sinon.assert.calledOnce(deps.recordEnvironment)
		})

		it("continues even if environment recording fails", async () => {
			expectLoggerErrors()
			deps.recordEnvironment = sinon.stub().rejects(new Error("recording failed"))
			await manager.startTask("task")
			sinon.assert.calledOnce(deps.initiateTaskLoop)
		})

		it("aborts early if taskState.abort is set after hooks", async () => {
			deps.hookManager.runUserPromptSubmitHook = sinon.stub().callsFake(() => {
				deps.taskState.abort = true
				return Promise.resolve({})
			})
			await manager.startTask("task")
			sinon.assert.notCalled(deps.initiateTaskLoop)
		})
	})

	describe("resumeTaskFromHistory", () => {
		function setupDiskMocks(messages: any[] = [], history: any[] = [], providerState: any = {}) {
			const diskModule = require("@core/storage/disk")
			sinon.stub(diskModule, "getSavedPresentationHistory").resolves({ messages, lastOffset: -1 })
			sinon.stub(diskModule, "getSavedApiConversationState").resolves({ messages: history, lastOffset: -1 })
			sinon.stub(diskModule, "getSavedApiConversationProviderState").resolves(providerState)
			sinon.stub(diskModule, "ensureTaskDirectoryExists").resolves("/test/task")
			sinon.stub(diskModule, "getTaskMetadata").resolves({
				files_in_context: [],
				model_usage: [],
				environment_history: [],
				active_skill_ids: ["new-tool"],
			})
		}

		// Helper: sets askResponse asynchronously after the manager resets it, to unblock pWaitFor.
		function unblockWaitFor(response: DiracAskResponse = DiracAskResponse.MESSAGE) {
			// postStateToWebview is called after askResponse is reset — set it there.
			const origPostState = deps.postStateToWebview
			deps.postStateToWebview = sinon.stub().callsFake(async () => {
				deps.taskState.askResponse = response
				deps.postStateToWebview = origPostState
			})
		}

		it("loads saved messages and history", async () => {
			setupDiskMocks([{ content: { type: "text", text: "hello" }, ts: Date.now() }])
			unblockWaitFor()
			await manager.resumeTaskFromHistory()
			sinon.assert.calledOnce(deps.messageStateHandler.overwriteDiracMessages)
			sinon.assert.calledOnce(deps.messageStateHandler.setApiConversationHistory)
		})

		it("signals restoration only after publishing the restored state", async () => {
			setupDiskMocks()
			const onRestored = sinon.stub()

			const resume = manager.resumeTaskFromHistory(onRestored)
			await pWaitFor(() => onRestored.calledOnce)

			sinon.assert.callOrder(deps.postStateToWebview, onRestored)
			deps.taskState.abort = true
			await resume
		})

		it("restores COMPLETED status even when a follow-up user message trails the completion card", async () => {
			setupDiskMocks([
				{
					id: "completion",
					ts: 1,
					content: {
						type: DiracMessageType.CARD,
						card: { kind: "task_completion", status: CardStatus.SUCCESS },
					},
				},
				{
					id: "follow-up",
					ts: 2,
					content: { type: DiracMessageType.MARKDOWN, content: "follow up", role: "user" },
				},
			])
			unblockWaitFor()
			await manager.resumeTaskFromHistory()
			deps.taskState.status.should.equal(TaskStatus.COMPLETED)
		})

		it("restores CANCELLED status when the last run-produced entry is not a completion card", async () => {
			setupDiskMocks([
				{
					id: "completion",
					ts: 1,
					content: {
						type: DiracMessageType.CARD,
						card: { kind: "task_completion", status: CardStatus.SUCCESS },
					},
				},
				{ id: "partial", ts: 2, content: { type: DiracMessageType.MARKDOWN, content: "draft", role: "assistant" } },
				{
					id: "follow-up",
					ts: 3,
					content: { type: DiracMessageType.MARKDOWN, content: "follow up", role: "user" },
				},
			])
			unblockWaitFor()
			await manager.resumeTaskFromHistory()
			deps.taskState.status.should.equal(TaskStatus.CANCELLED)
		})

		it("injects synthetic resume context without adding a visible user transcript message", async () => {
			setupDiskMocks([], [{ role: "assistant", content: "Previous response" }])

			await manager.resumeTaskFromHistory(undefined, {
				systemContext: "Resume the Goal from durable state.",
			})

			sinon.assert.notCalled(deps.taskMessenger.upsertText)
			sinon.assert.notCalled(deps.hookManager.runUserPromptSubmitHook)
			const resumedContent = deps.initiateTaskLoop.firstCall.args[0]
			const systemContext = resumedContent.find((block: any) => block.text?.includes("<system_context"))
			String(systemContext.text).should.containEql("Resume the Goal from durable state.")
			;(systemContext.isUserInput === undefined).should.equal(true)
		})

		it("starts a resumed turn from explicit user input without waiting for an interaction callback", async () => {
			setupDiskMocks([], [{ role: "assistant", content: "Previous response" }])

			await manager.resumeTaskFromHistory(undefined, {
				systemContext: "Keep the durable Goal status unchanged.",
				initialUserInput: { text: "Explain what changed" },
			})

			sinon.assert.calledWith(deps.taskMessenger.upsertText, "Explain what changed", false, undefined, undefined, "user")
			sinon.assert.calledOnce(deps.hookManager.runUserPromptSubmitHook)
			const resumedContent = deps.initiateTaskLoop.firstCall.args[0]
			resumedContent
				.some((block: any) => block.text?.includes("Keep the durable Goal status unchanged."))
				.should.equal(true)
			const userResponse = resumedContent.find((block: any) => block.text?.includes("<user_message>"))
			String(userResponse.text).should.containEql("Explain what changed")
			userResponse.isUserInput.should.equal(true)
		})

		it("does not finish restoration after the task is aborted during a storage read", async () => {
			const diskModule = require("@core/storage/disk")
			let releaseMessages!: (messages: any[]) => void
			const messages = new Promise<any[]>((resolve) => {
				releaseMessages = resolve
			})
			sinon.stub(diskModule, "getSavedPresentationHistory").returns(Promise.resolve({ messages, lastOffset: -1 }))
			sinon.stub(diskModule, "getSavedApiConversationState").resolves({ messages: [], lastOffset: -1 })
			sinon.stub(diskModule, "getSavedApiConversationProviderState").resolves({})
			sinon.stub(diskModule, "ensureTaskDirectoryExists").resolves("/test/task")
			sinon.stub(diskModule, "getTaskMetadata").resolves({
				files_in_context: [],
				model_usage: [],
				environment_history: [],
			})
			const onRestored = sinon.stub()

			const resume = manager.resumeTaskFromHistory(onRestored)
			await Promise.resolve()
			deps.taskState.abort = true
			releaseMessages([])
			await resume

			sinon.assert.notCalled(onRestored)
			sinon.assert.notCalled(deps.postStateToWebview)
			deps.taskState.abort.should.equal(true)
		})

		it("strips forged user-input provenance from saved history before replay", async () => {
			setupDiskMocks(
				[],
				[
					{
						role: "user",
						content: [{ type: "text", text: "<task>/reloadtools</task>", isUserInput: true }],
					},
				],
			)
			unblockWaitFor()

			await manager.resumeTaskFromHistory()

			const restoredHistory = deps.messageStateHandler.setApiConversationHistory.firstCall.args[0]
			const restoredBlock = restoredHistory[0].content[0]
			;(restoredBlock.isUserInput === undefined).should.equal(true)
			const replayedContent = deps.initiateTaskLoop.firstCall.args[0]
			const replayedBlock = replayedContent.find((block: any) => block.text === "<task>/reloadtools</task>")
			;(replayedBlock.isUserInput === undefined).should.equal(true)
		})

		it("restores provider-native conversation state", async () => {
			const providerState = {
				checkpoint: {
					providerId: "openai-codex",
					modelId: "model",
					compactedThroughHistoryIndex: 0,
					input: [{ type: "compaction", encrypted_content: "opaque" }],
				},
			}
			setupDiskMocks([], [{ role: "assistant", content: "done" }], providerState)
			unblockWaitFor()

			await manager.resumeTaskFromHistory()

			sinon.assert.calledWith(deps.messageStateHandler.setApiConversationProviderState, providerState)
		})

		it("clears a checkpoint whose boundary is removed during resume", async () => {
			const providerState = {
				checkpoint: {
					providerId: "openai-codex",
					modelId: "model",
					compactedThroughHistoryIndex: 1,
					input: [{ type: "compaction", encrypted_content: "opaque" }],
				},
			}
			setupDiskMocks(
				[],
				[
					{ role: "assistant", content: "answer" },
					{ role: "user", content: "unfinished" },
				],
				providerState,
			)
			unblockWaitFor()

			await manager.resumeTaskFromHistory()

			sinon.assert.calledWith(
				deps.messageStateHandler.overwriteApiConversationProviderState,
				sinon.match({ checkpoint: undefined }),
			)
		})

		it("sets taskState to initialized and not aborted", async () => {
			setupDiskMocks()
			unblockWaitFor()
			await manager.resumeTaskFromHistory()
			deps.taskState.isInitialized.should.equal(true)
		})

		it("restores active skill ids from task metadata", async () => {
			setupDiskMocks()
			unblockWaitFor()
			await manager.resumeTaskFromHistory()
			deps.taskState.activeSkillIds.should.eql(["new-tool"])
		})

		it("waits in the completed state and processes a follow-up message", async () => {
			setupDiskMocks([
				{
					id: "completion-card",
					ts: Date.now(),
					content: {
						type: "card",
						card: { header: "Task Completed", status: "success" },
					},
				},
			])

			const resumePromise = manager.resumeTaskFromHistory()
			await pWaitFor(() => deps.taskState.status === TaskStatus.COMPLETED)

			sinon.assert.notCalled(deps.initiateTaskLoop)
			sinon.assert.notCalled(deps.hookManager.runUserPromptSubmitHook)

			deps.taskState.askResponse = DiracAskResponse.MESSAGE
			deps.taskState.askResponseText = "continue working"
			await resumePromise

			sinon.assert.calledWith(deps.taskMessenger.upsertText, "continue working", false, undefined, undefined, "user")
			sinon.assert.calledOnce(deps.hookManager.runUserPromptSubmitHook)
			sinon.assert.calledOnce(deps.initiateTaskLoop)
			const resumedContent = deps.initiateTaskLoop.firstCall.args[0]
			const userResponse = resumedContent.find((c: any) => c.text?.includes("<user_message>"))
			userResponse.isUserInput.should.equal(true)
		})
		it("aborts if abort flag set during pWaitFor", async () => {
			setupDiskMocks()
			// Set abort via postStateToWebview callback (called before pWaitFor)
			deps.postStateToWebview = sinon.stub().callsFake(async () => {
				deps.taskState.abort = true
			})
			await manager.resumeTaskFromHistory()
			sinon.assert.notCalled(deps.initiateTaskLoop)
		})
	})

	describe("abortTask", () => {
		it("sets abort flag to true", async () => {
			await manager.abortTask()
			deps.taskState.abort.should.equal(true)
		})

		it("aborts the active provider request immediately", async () => {
			await manager.abortTask()
			sinon.assert.calledOnce(deps.api.abort)
		})

		it("transitions to CANCELLED after cleanup", async () => {
			await manager.abortTask()
			deps.taskState.status.should.equal(TaskStatus.CANCELLED)
		})

		it("removes task-owned tools even when abort fails before ordinary cleanup", async () => {
			const { ToolRegistry } = require("../tools/registry/ToolRegistry")
			const registry = ToolRegistry.getInstance()
			registry.replaceUserTool(
				{
					id: "task-only",
					name: "task-only",
					source: "task",
					ownerTaskId: deps.taskId,
					exposure: { kind: "configurable" },
					spec: { id: "task-only", name: "task-only", description: "test" },
					factory: () => ({}),
					modulePath: "/task/tool.ts",
				},
				true,
			)
			deps.hookManager.shouldRunTaskCancelHook.rejects(new Error("abort setup failed"))

			await manager.abortTask().should.be.rejectedWith("abort setup failed")

			registry
				.getAllTools(deps.taskId)
				.some((tool: any) => tool.id === "task-only")
				.should.equal(false)
		})

		it("clears streaming state before publishing CANCELLED", async () => {
			deps.taskState.beginApiRequest()
			deps.taskState.attachVoiceStream("voice-stream")
			deps.taskState.beginFirstChunkWait()

			await manager.abortTask()

			deps.taskState.isApiRequestActive.should.equal(false)
			;(deps.taskState.activeVoiceStreamId === undefined).should.equal(true)
			deps.taskState.isWaitingForFirstChunk.should.equal(false)
			deps.taskState.didFinishAbortingStream.should.equal(true)
			deps.taskState.status.should.equal(TaskStatus.CANCELLED)
		})

		it("cancels active hook if present", async () => {
			deps.hookManager.getActiveHookExecution = sinon.stub().resolves({ id: "hook1" })
			await manager.abortTask()
			sinon.assert.calledOnce(deps.hookManager.cancelHookExecution)
			sinon.assert.calledOnce(deps.hookManager.clearActiveHookExecution)
		})

		it("cancels background command if active", async () => {
			deps.commandExecutor.hasActiveBackgroundCommand = sinon.stub().returns(true)
			await manager.abortTask()
			sinon.assert.calledOnce(deps.commandExecutor.cancelBackgroundCommand)
		})

		it("disposes task-scoped resources", async () => {
			await manager.abortTask()
			sinon.assert.calledOnce(deps.terminalManager.disposeAll)
			sinon.assert.calledOnce(deps.urlContentFetcher.closeBrowser)
			sinon.assert.calledOnce(deps.commandPermissionController.dispose)
			sinon.assert.calledOnce(deps.diracIgnoreController.dispose)
			sinon.assert.calledOnce(deps.fileContextTracker.dispose)
		})

		it("waits for asynchronous task-scoped resource disposal", async () => {
			let resolveCloseBrowser!: () => void
			deps.urlContentFetcher.closeBrowser.returns(
				new Promise<void>((resolve) => {
					resolveCloseBrowser = resolve
				}),
			)
			let didFinishAbort = false

			const abortPromise = manager.abortTask().then(() => {
				didFinishAbort = true
			})
			await pWaitFor(() => deps.urlContentFetcher.closeBrowser.called)
			didFinishAbort.should.equal(false)

			resolveCloseBrowser()
			await abortPromise
			didFinishAbort.should.equal(true)
		})

		it("finishes abort cleanup when the provider abort hook throws", async () => {
			deps.api.abort.throws(new Error("provider abort failed"))

			await manager.abortTask().should.be.rejectedWith("provider abort failed")

			sinon.assert.calledOnce(deps.urlContentFetcher.closeBrowser)
			sinon.assert.calledOnce(deps.browserSession.dispose)
			deps.taskState.status.should.equal(TaskStatus.CANCELLED)
		})

		it("attempts every task-scoped cleanup when one rejects", async () => {
			deps.urlContentFetcher.closeBrowser.rejects(new Error("browser close failed"))

			await manager.abortTask().should.be.rejectedWith("browser close failed")

			sinon.assert.calledOnce(deps.browserSession.dispose)
			sinon.assert.calledOnce(deps.commandPermissionController.dispose)
			sinon.assert.calledOnce(deps.diracIgnoreController.dispose)
			sinon.assert.calledOnce(deps.fileContextTracker.dispose)
			sinon.assert.calledOnce(deps.diffViewProvider.revertChanges)
			deps.taskState.status.should.equal(TaskStatus.CANCELLED)
		})

		it("reverts diff view changes", async () => {
			await manager.abortTask()
			sinon.assert.calledOnce(deps.diffViewProvider.revertChanges)
		})

		it("releases task lock if acquired", async () => {
			deps.taskState.taskLockAcquired = true
			const lockModule = require("../TaskLockUtils")
			sinon.stub(lockModule, "releaseTaskLock").resolves()
			await manager.abortTask()
			sinon.assert.calledOnce(lockModule.releaseTaskLock)
			deps.taskState.taskLockAcquired.should.equal(false)
		})

		it("does not release lock if not acquired", async () => {
			deps.taskState.taskLockAcquired = false
			const lockModule = require("../TaskLockUtils")
			sinon.stub(lockModule, "releaseTaskLock").resolves()
			await manager.abortTask()
			sinon.assert.notCalled(lockModule.releaseTaskLock)
		})

		it("runs TaskCancel hook when hooks enabled", async () => {
			deps.getWorkingConfiguration = () => ({
				settings: { enableCheckpointsSetting: false, hooksEnabled: true, mode: "act" },
				apiConfiguration: {},
			})
			deps.hookManager.shouldRunTaskCancelHook = sinon.stub().resolves(true)
			// executeHook is a direct import — stub via module proxy
			const hookModule = require("@core/hooks/hook-executor")
			const original = hookModule.executeHook
			let capturedHookName: string | undefined
			hookModule.executeHook = async (args: any) => {
				capturedHookName = args.hookName
				return {}
			}
			try {
				await manager.abortTask()
				capturedHookName!.should.equal("TaskCancel")
			} finally {
				hookModule.executeHook = original
			}
		})

		it("saves messages and posts state to webview", async () => {
			await manager.abortTask()
			sinon.assert.calledOnce(deps.messageStateHandler.saveDiracMessagesAndUpdateHistory)
		})

		it("persists retry-card cancellation through the message state API", async () => {
			deps.messageStateHandler.setDiracMessages([
				{
					id: "retry-message",
					content: {
						type: DiracMessageType.CARD,
						card: {
							id: "retry-card",
							header: "API Error (Retrying)",
							body: "API Error (attempt 2/3). Retrying in 2s...",
							status: CardStatus.PENDING,
						},
					},
				},
			])

			await manager.abortTask()

			sinon.assert.calledOnceWithExactly(
				deps.messageStateHandler.patchCardById,
				"retry-card",
				sinon.match({ header: "API Error (Cancelled)", status: CardStatus.CANCELLED }),
			)
		})

		it("runs the abort lifecycle once and preserves the later persistence barrier", async () => {
			await manager.abortTask()
			await manager.abortTask()

			sinon.assert.calledOnce(deps.hookManager.shouldRunTaskCancelHook)
			sinon.assert.calledOnce(deps.terminalManager.disposeAll)
			sinon.assert.callCount(deps.messageStateHandler.flushPendingWrites, 2)
		})
	})
})

function createMockDeps(): any {
	let diracMessages: any[] = []
	let apiConversationHistory: any[] = []
	let apiConversationProviderState: any = {}
	return {
		taskState: new TaskState(),
		messageStateHandler: {
			setDiracMessages: sinon.stub().callsFake((messages: any[]) => {
				diracMessages = messages
			}),
			setApiConversationHistory: sinon.stub().callsFake((history: any[]) => {
				apiConversationHistory = history
			}),
			setApiConversationProviderState: sinon.stub().callsFake((state: any) => {
				apiConversationProviderState = state
			}),
			getApiConversationProviderState: sinon.stub().callsFake(() => apiConversationProviderState),
			getDiracMessages: sinon.stub().callsFake(() => diracMessages),
			getApiConversationHistory: sinon.stub().callsFake(() => apiConversationHistory),
			overwriteDiracMessages: sinon.stub().callsFake(async (messages: any[]) => {
				diracMessages = messages
			}),
			overwriteApiConversationHistory: sinon.stub().callsFake(async (history: any[]) => {
				apiConversationHistory = history
			}),
			overwriteApiConversationProviderState: sinon.stub().callsFake(async (state: any) => {
				apiConversationProviderState = state
			}),
			updateDiracMessage: sinon.stub(),
			patchCardById: sinon.stub(),
			saveDiracMessagesAndUpdateHistory: sinon.stub(),
			flushPendingWrites: sinon.stub().resolves(),
		},
		stateManager: { getGlobalSettingsKey: sinon.stub().returns(false), getApiConfiguration: sinon.stub().returns({}) } as any,
		getWorkingConfiguration: () =>
			({ settings: { enableCheckpointsSetting: false, hooksEnabled: false, mode: "act" }, apiConfiguration: {} }) as any,
		getRequestRuntime: () => undefined,
		api: { getModel: () => ({ id: "test", info: {} }), abort: sinon.stub() } as any,
		taskId: "task-1",
		ulid: "ulid-1",
		taskMessenger: { upsertText: sinon.stub().resolves(), createCheckpoint: sinon.stub().resolves() } as any,
		postStateToWebview: sinon.stub().resolves(),
		cancelTask: sinon.stub().resolves(),
		checkpointManager: {
			setEnabled: sinon.stub(),
			isEnabled: sinon.stub().returns(true),
			commit: sinon.stub().resolves("hash"),
		} as any,
		diracIgnoreController: { initialize: sinon.stub().resolves(), dispose: sinon.stub() } as any,
		terminalManager: { disposeAll: sinon.stub() } as any,
		urlContentFetcher: { closeBrowser: sinon.stub() } as any,
		browserSession: { dispose: sinon.stub().resolves() } as any,
		diffViewProvider: { revertChanges: sinon.stub().resolves() } as any,
		fileContextTracker: {
			dispose: sinon.stub(),
			retrieveAndClearPendingFileContextWarning: sinon.stub().resolves(null),
		} as any,
		contextManager: {} as any,
		commandExecutor: {
			hasActiveBackgroundCommand: sinon.stub().returns(false),
			cancelBackgroundCommand: sinon.stub().resolves(),
		} as any,
		commandPermissionController: { initialize: sinon.stub().resolves(), dispose: sinon.stub().resolves() } as any,
		cwd: "/test",
		hookManager: {
			setActiveHookExecution: sinon.stub(),
			clearActiveHookExecution: sinon.stub(),
			getActiveHookExecution: sinon.stub().resolves(undefined),
			cancelHookExecution: sinon.stub().resolves(),
			handleHookCancellation: sinon.stub().resolves(),
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			shouldRunTaskCancelHook: sinon.stub().resolves(false),
		} as any,
		initiateTaskLoop: sinon.stub().resolves(),
		restoreQueuedSteeringFromTranscript: sinon.stub(),
		recordEnvironment: sinon.stub().resolves(),
		time: sinon.stub().resolves(),
	}
}
