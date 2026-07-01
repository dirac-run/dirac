import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { MessageStateHandler } from "@core/task/message-state"
import type { TaskMessenger } from "@core/task/TaskMessenger"
import type { TaskState } from "@core/task/TaskState"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { expect } from "chai"
import sinon from "sinon"
import { HostProvider } from "../../../hosts/host-provider"
import { TaskCheckpointManager } from "../index"
import { expectLoggerErrors } from "@/test/loggerGuard"

// Minimal mock factory for DiracMessage
function makeMessage(overrides: Partial<DiracMessage> = {}): DiracMessage {
	return {
		id: "msg-1",
		ts: Date.now(),
		content: { type: "text", content: ["hello"] } as any,
		...overrides,
	} as DiracMessage
}

// Mock factory for TaskCheckpointManager dependencies
function makeMocks(sandbox: sinon.SinonSandbox) {
	const diracMessages: DiracMessage[] = []

	const messageStateHandler = {
		getDiracMessages: sandbox.stub().returns(diracMessages),
		getApiConversationHistory: sandbox.stub().returns([]),
		setCheckpointTracker: sandbox.stub(),
		saveDiracMessagesAndUpdateHistory: sandbox.stub().resolves(),
		overwriteApiConversationHistory: sandbox.stub().resolves(),
		overwriteDiracMessages: sandbox.stub().resolves(),
	} as unknown as MessageStateHandler & { getDiracMessages: sinon.SinonStub }

	const taskState = {
		conversationHistoryDeletedRange: undefined,
		checkpointManagerErrorMessage: undefined,
	} as TaskState

	const fileContextTracker = {
		detectFilesEditedAfterMessage: sandbox.stub().resolves([]),
		storePendingFileContextWarning: sandbox.stub().resolves(),
	} as unknown as FileContextTracker

	const diffViewProvider = {} as DiffViewProvider

	const taskMessenger = {
		createCheckpoint: sandbox.stub().resolves({ id: "checkpoint-card-1" }),
		upsertApiStatus: sandbox.stub().resolves(),
	} as unknown as TaskMessenger

	const callbacks = {
		updateTaskHistory: sandbox.stub().resolves([]),
		cancelTask: sandbox.stub().resolves(),
		taskMessenger,
		postStateToWebview: sandbox.stub().resolves(),
		resetTransientState: sandbox.stub().resolves(),
	}

	return { diracMessages, messageStateHandler, taskState, fileContextTracker, diffViewProvider, taskMessenger, callbacks }
}

function makeManager(sandbox: sinon.SinonSandbox, overrides: { enableCheckpoints?: boolean; messages?: DiracMessage[] } = {}) {
	const mocks = makeMocks(sandbox)
	if (overrides.messages) {
		mocks.diracMessages.push(...overrides.messages)
	}

	const manager = new TaskCheckpointManager(
		{ taskId: "test-task-1" },
		{ enableCheckpoints: overrides.enableCheckpoints ?? true },
		{
			fileContextTracker: mocks.fileContextTracker,
			diffViewProvider: mocks.diffViewProvider,
			messageStateHandler: mocks.messageStateHandler,
			taskState: mocks.taskState,
		},
		mocks.callbacks,
		{},
	)

	return { manager, ...mocks }
}

describe("TaskCheckpointManager", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		// Stub HostProvider to avoid needing full initialization
		sandbox.stub(HostProvider, "get").returns({
			hostBridge: {
				windowClient: { showMessage: sandbox.stub() },
				diffClient: { openMultiFileDiff: sandbox.stub().resolves() },
			},
		} as any)
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("saveCheckpoint", () => {
		it("returns early when checkpoints are disabled", async () => {
			const { manager, taskMessenger } = makeManager(sandbox, { enableCheckpoints: false })
			await manager.saveCheckpoint()
			expect((taskMessenger.createCheckpoint as sinon.SinonStub).called).to.equal(false)
		})

		it("returns early when checkpoint manager has timeout error", async () => {
			const { manager, taskMessenger, messageStateHandler } = makeManager(sandbox, { enableCheckpoints: true })
			// Set error state by using the public state setter
			manager.setcheckpointManagerErrorMessage("Checkpoints initialization timed out.")
			await manager.saveCheckpoint()
			expect((taskMessenger.createCheckpoint as sinon.SinonStub).called).to.equal(false)
		})

		it("skips back-to-back checkpoint messages", async () => {
			const checkpointMsg = makeMessage({ id: "msg-cp", content: { type: "checkpoint" } as any })
			const { manager, taskMessenger } = makeManager(sandbox, {
				messages: [checkpointMsg],
			})
			// Set tracker so it doesn't try to init
			manager.setCheckpointTracker({ commit: sandbox.stub().resolves("hash-1") } as any)
			await manager.saveCheckpoint()
			expect((taskMessenger.createCheckpoint as sinon.SinonStub).called).to.equal(false)
		})
	})

	describe("commit", () => {
		it("returns undefined when checkpoints are disabled", async () => {
			const { manager } = makeManager(sandbox, { enableCheckpoints: false })
			const result = await manager.commit()
			expect(result).to.equal(undefined)
		})

		it("delegates to tracker.commit when tracker is available", async () => {
			const { manager } = makeManager(sandbox)
			const commitStub = sandbox.stub().resolves("commit-hash-123")
			manager.setCheckpointTracker({ commit: commitStub } as any)
			const result = await manager.commit()
			expect(result).to.equal("commit-hash-123")
			expect(commitStub.calledOnce).to.equal(true)
		})
	})

	describe("doesLatestTaskCompletionHaveNewChanges", () => {
		it("returns false when checkpoints are disabled", async () => {
			const { manager } = makeManager(sandbox, { enableCheckpoints: false })
			const result = await manager.doesLatestTaskCompletionHaveNewChanges()
			expect(result).to.equal(false)
		})

		it("returns false when no completion result message exists", async () => {
			expectLoggerErrors()
			const { manager } = makeManager(sandbox, { messages: [makeMessage()] })
			manager.setCheckpointTracker({ getDiffCount: sandbox.stub() } as any)
			const result = await manager.doesLatestTaskCompletionHaveNewChanges()
			expect(result).to.equal(false)
		})
	})

	describe("checkpointTrackerCheckAndInit", () => {
		it("returns existing tracker without re-initializing", async () => {
			const { manager } = makeManager(sandbox)
			const tracker = { commit: sandbox.stub() } as any
			manager.setCheckpointTracker(tracker)
			const result = await manager.checkpointTrackerCheckAndInit()
			expect(result).to.equal(tracker)
		})
	})

	describe("state management", () => {
		it("setCheckpointTracker updates internal state", () => {
			const { manager } = makeManager(sandbox)
			const tracker = { commit: sandbox.stub() } as any
			manager.setCheckpointTracker(tracker)
			const state = manager.getCurrentState()
			expect(state.checkpointTracker).to.equal(tracker)
		})

		it("setcheckpointManagerErrorMessage updates state and taskState", async () => {
			const { manager, taskState } = makeManager(sandbox)
			await manager.setcheckpointManagerErrorMessage("some error")
			const state = manager.getCurrentState()
			expect(state.checkpointManagerErrorMessage).to.equal("some error")
			expect(taskState.checkpointManagerErrorMessage).to.equal("some error")
		})

		it("updateConversationHistoryDeletedRange updates state", () => {
			const { manager } = makeManager(sandbox)
			manager.updateConversationHistoryDeletedRange([5, 10])
			const state = manager.getCurrentState()
			expect(state.conversationHistoryDeletedRange).to.deep.equal([5, 10])
		})

		it("getCurrentState returns frozen readonly state", () => {
			const { manager } = makeManager(sandbox)
			const state = manager.getCurrentState()
			expect(Object.isFrozen(state)).to.equal(true)
		})
	})

	describe("restoreCheckpoint", () => {
		it("returns empty object when message not found", async () => {
			expectLoggerErrors()
			const { manager } = makeManager(sandbox, { messages: [makeMessage({ id: "msg-1" })] })
			const result = await manager.restoreCheckpoint("nonexistent", "task")
			expect(result).to.deep.equal({})
		})

		it("returns state update with conversationHistoryDeletedRange for task restore", async () => {
			const msg = makeMessage({ id: "msg-1", conversationHistoryDeletedRange: [0, 5], conversationHistoryIndex: 3 })
			const { manager, messageStateHandler } = makeManager(sandbox, { messages: [msg] })
			// Task restore doesn't need tracker, just message state manipulation
			const result = await manager.restoreCheckpoint("msg-1", "task")
			expect(result.conversationHistoryDeletedRange).to.deep.equal([0, 5])
		})
	})
})
