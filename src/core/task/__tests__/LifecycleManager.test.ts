import "should"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { DiracAskResponse } from "@shared/WebviewMessage"
import sinon from "sinon"
import { LifecycleManager } from "../LifecycleManager"

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
			deps.stateManager.getGlobalSettingsKey = sinon.stub().withArgs("enableCheckpointsSetting").returns(true)
			deps.checkpointManager.commit = sinon.stub().resolves("commit-hash")
			deps.messageStateHandler.getDiracMessages = sinon.stub().returns([{ content: { type: "checkpoint" } }])
			// Stub ensureCheckpointInitialized via module proxy
			const initModule = require("@integrations/checkpoints/initializer")
			const origInit = initModule.ensureCheckpointInitialized
			initModule.ensureCheckpointInitialized = async () => { }
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
			deps.stateManager.getGlobalSettingsKey = sinon.stub().withArgs("enableCheckpointsSetting").returns(true)
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
			userContent[1].type.should.equal("image")
		})

		it("includes file content when files provided", async () => {
			const extractModule = require("@integrations/misc/extract-text")
			sinon.stub(extractModule, "processFilesIntoText").resolves("file content here")
			await manager.startTask("task", undefined, ["file1.ts"])
			const userContent = deps.initiateTaskLoop.firstCall.args[0]
			userContent.some((c: any) => c.text === "file content here").should.equal(true)
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
		function setupDiskMocks(messages: any[] = [], history: any[] = []) {
			const diskModule = require("@core/storage/disk")
			sinon.stub(diskModule, "getSavedDiracMessages").resolves(messages)
			sinon.stub(diskModule, "getSavedApiConversationHistory").resolves(history)
			sinon.stub(diskModule, "ensureTaskDirectoryExists").resolves()
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

		it("sets taskState to initialized and not aborted", async () => {
			setupDiskMocks()
			unblockWaitFor()
			deps.taskState.abort = true
			await manager.resumeTaskFromHistory()
			deps.taskState.isInitialized.should.equal(true)
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

		it("disposes terminal, browser, ignore controller, and file context tracker", async () => {
			await manager.abortTask()
			sinon.assert.calledOnce(deps.terminalManager.disposeAll)
			sinon.assert.calledOnce(deps.urlContentFetcher.closeBrowser)
			sinon.assert.calledOnce(deps.diracIgnoreController.dispose)
			sinon.assert.calledOnce(deps.fileContextTracker.dispose)
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
			deps.stateManager.getGlobalSettingsKey = sinon.stub().withArgs("hooksEnabled").returns(true)
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
	})
})

function createMockDeps(): any {
	return {
		taskState: { isInitialized: false, abort: false, askResponse: undefined } as any,
		messageStateHandler: {
			setDiracMessages: sinon.stub(),
			setApiConversationHistory: sinon.stub(),
			getDiracMessages: sinon.stub().returns([]),
			getApiConversationHistory: sinon.stub().returns([]),
			overwriteDiracMessages: sinon.stub(),
			overwriteApiConversationHistory: sinon.stub(),
			updateDiracMessage: sinon.stub(),
			saveDiracMessagesAndUpdateHistory: sinon.stub(),
		},
		stateManager: { getGlobalSettingsKey: sinon.stub().returns(false), getApiConfiguration: sinon.stub().returns({}) } as any,
		api: { getModel: () => ({ id: "test", info: {} }) } as any,
		taskId: "task-1",
		ulid: "ulid-1",
		taskMessenger: { upsertText: sinon.stub().resolves(), createCheckpoint: sinon.stub().resolves() } as any,
		postStateToWebview: sinon.stub().resolves(),
		cancelTask: sinon.stub().resolves(),
		checkpointManager: { commit: sinon.stub().resolves("hash") } as any,
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
		commandPermissionController: { initialize: sinon.stub().resolves() } as any,
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
		recordEnvironment: sinon.stub().resolves(),
		time: sinon.stub().resolves(),
	}
}
