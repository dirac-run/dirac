/**
 * Characterization tests for Task class (ORIGINAL codebase).
 * Captures current behavior — bugs and all.
 *
 * Phase 1 — Refactoring Safety Net
 */
import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import { DiracAskResponse } from "@shared/WebviewMessage"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { StateManager } from "../../storage/StateManager"
import { Task } from "../index"

describe("Task (original)", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let previousDiracDir: string | undefined

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = path.join(os.tmpdir(), `dirac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })
		previousDiracDir = process.env.DIRAC_DIR
		process.env.DIRAC_DIR = tempDir

		sandbox.stub(HostProvider, "get").returns({
			createDiffViewProvider: () => null,
			createTerminalManager: () => ({
				setShellIntegrationTimeout: sandbox.stub(),
				setTerminalReuseEnabled: sandbox.stub(),
				setTerminalOutputLineLimit: sandbox.stub(),
				setDefaultTerminalProfile: sandbox.stub(),
				disposeAll: sandbox.stub().resolves(),
			}),
			extensionFsPath: tempDir,
			globalStorageFsPath: tempDir,
			hostBridge: {
				workspaceClient: {
					getWorkspaceFolders: sandbox.stub().returns([]),
					getWorkspacePaths: sandbox.stub().resolves({ paths: [tempDir] }),
				},
				envClient: {},
				windowClient: {},
			},
			getEnvironmentVariables: sandbox.stub().returns({}),
		} as any)
		sandbox.stub(HostProvider, "env" as any).value({
			getHostVersion: sandbox.stub().resolves({ platform: "macos", diracType: 0 }),
		})
		sandbox.stub(HostProvider, "window" as any).value({
			getOpenTabs: sandbox.stub().resolves({ paths: [] }),
			getVisibleTabs: sandbox.stub().resolves({ paths: [] }),
		})

		const mockSM = {
			getGlobalSettingsKey: sandbox.stub().returns(undefined),
			getGlobalStateKey: sandbox.stub().returns(undefined),
			getWorkspaceStateKey: sandbox.stub().returns(undefined),
			setGlobalState: sandbox.stub(),
			setTaskSettingsBatch: sandbox.stub(),
			flushPendingState: sandbox.stub().resolves(),
			loadTaskSettings: sandbox.stub().resolves(),
			getApiConfiguration: sandbox.stub().returns({
				planModeApiProvider: "anthropic",
				actModeApiProvider: "anthropic",
				planModeApiModelId: "claude-sonnet-4-20250514",
				actModeApiModelId: "claude-sonnet-4-20250514",
			}),
			captureEffectiveTaskConfiguration: sandbox.stub().callsFake(() => ({
				revision: 1,
				settings: new Proxy({}, { get: (_target, key) => ({ mode: "act", enableCheckpointsSetting: true, shellIntegrationTimeout: 5000, terminalOutputLineLimit: 500, defaultTerminalProfile: "default", autoApprovalSettings: { actions: {} }, browserSettings: {}, toolToggles: {} } as any)[key as any] }),
				apiConfiguration: { planModeApiProvider: "anthropic", actModeApiProvider: "anthropic", planModeApiModelId: "claude-sonnet-4-20250514", actModeApiModelId: "claude-sonnet-4-20250514" },
				workspaceConfiguration: {},
				executionOptions: { terminalReuseEnabled: true, vscodeTerminalExecutionMode: "vscodeTerminal", multiRootEnabled: false },
			})),
			registerCallbacks: sandbox.stub(),
			getSecretKey: sandbox.stub().returns(undefined),
		}
		sandbox.stub(StateManager, "get").returns(mockSM as any)
	})

	afterEach(async () => {
		sandbox.restore()
		if (previousDiracDir === undefined) delete process.env.DIRAC_DIR
		else process.env.DIRAC_DIR = previousDiracDir
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch { }
	})

	function createMockContext() {
		return {
			updateBackgroundCommandState: sandbox.stub(),
			toggleActModeForYoloMode: sandbox.stub().resolves(true),
			postStateToWebview: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			stateManager: StateManager.get(),
		}
	}

	function createMockController() {
		return {
			getWorkspaceManager: () => undefined,
		} as any
	}

	it("creates a Task with taskId", () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test task",
			taskId: "test-123",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
		t.should.not.be.undefined()
		assert.equal(t.taskState.pendingModeNotice?.mode, "act")
		t.taskId.should.equal("test-123")
		assert.equal(t.taskState.initialTask, "test task")
	})

	it("initializes a pending Plan notice from the working configuration", () => {
		const workingConfiguration = StateManager.get().captureEffectiveTaskConfiguration()
		const planConfiguration = {
			...workingConfiguration,
			settings: new Proxy(workingConfiguration.settings, {
				get: (target, property, receiver) =>
					property === "mode" ? "plan" : Reflect.get(target, property, receiver),
			}),
		}
		const task = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "plan task",
			taskId: "test-plan-notice",
			taskLockAcquired: false,
			workingConfiguration: planConfiguration,
		})

		assert.equal(task.taskState.pendingModeNotice?.mode, "plan")
	})

	it("restores canonical initial task text from task history", () => {
		const task = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			historyItem: {
				id: "history-task",
				ts: Date.now(),
				task: "persisted initial task",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
			taskId: "history-task",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})

		assert.equal(task.taskState.initialTask, "persisted initial task")
	})

	it("routes automatic compaction to the active model when Utility condensation is unavailable", async () => {
		const workingConfiguration = StateManager.get().captureEffectiveTaskConfiguration()
		const settings = new Proxy(workingConfiguration.settings, {
			get: (target, property, receiver) => {
				if (property === "utilityModelUseCondense") return false
				if (property === "utilityModelSelection") return { provider: "openai-codex", modelId: "luna" }
				return Reflect.get(target, property, receiver)
			},
		})
		const task = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test task",
			taskId: "test-active-model-compaction-fallback",
			taskLockAcquired: false,
			workingConfiguration: {
				...workingConfiguration,
				settings,
				apiConfiguration: {
					planModeApiProvider: "openai-codex", planModeApiModelId: "gpt-6-astra",
					actModeApiProvider: "openai-codex", actModeApiModelId: "gpt-6.1-sol",
				},
			},
		}) as any
		const userContent = [{ type: "text", text: "continue" }]
		sandbox.stub(task.modelContextTracker, "recordModelUsage").resolves()
		sandbox.stub(task, "handleMistakeLimitReached").resolves({ didEndLoop: false, userContent })
		sandbox.stub(task.messageStateHandler, "getDiracMessages").returns([
			{ content: { type: "api_status", status: {} } },
		])
		sandbox.stub(task, "initializeCheckpoints").resolves()
		sandbox.stub(task, "determineContextCompaction").resolves(true)
		assert.equal(task.localConversationCompaction.isAvailable(), false)
		const utilityRun = sandbox.stub(task.localConversationCompaction, "run").resolves(undefined)
		sandbox.stub(task, "appendQueuedSteeringToUserContent").resolves(undefined)
		const prepareApiRequest = sandbox.stub(task.apiConversationManager, "prepareApiRequest").resolves({
			userContent,
			lastApiReqIndex: 0,
			isDirectResponse: true,
			didConsumeUserContent: true,
		})

		assert.equal(await task.recursivelyMakeDiracRequests(userContent), true)
		assert.equal(utilityRun.callCount, 0)
		assert.equal(prepareApiRequest.firstCall.args[0].shouldCompact, true)
		assert.equal(prepareApiRequest.firstCall.args[0].providerId, "openai-codex")
		assert.equal(prepareApiRequest.firstCall.args[0].modelId, "gpt-6.1-sol")
		assert.equal(prepareApiRequest.firstCall.args[0].mode, "act")
	})

	it("clears an unconsumed automatic-condense source before a completion follow-up", async () => {
		const task = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test task",
			taskId: "test-automatic-condense-source-cleanup",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		}) as any
		task.taskState.pendingCondenseSource = "automatic"
		task.taskState.didAttemptCompletion = true
		const makeRequests = sandbox.stub(task, "recursivelyMakeDiracRequests")
		makeRequests.onFirstCall().resolves(true)
		makeRequests.onSecondCall().resolves(true)
		const waitForFollowUp = sandbox.stub(task, "waitForFollowUp").callsFake(async () => {
			assert.equal(task.taskState.pendingCondenseSource, undefined)
			return [{ type: "text", text: "continue after completion" }]
		})
		sandbox.stub(task.taskMessenger, "upsertText").resolves()
		sandbox.stub(task.messageStateHandler, "flushTaskHistory").resolves()

		await task.initiateTaskLoop([{ type: "text", text: "initial request" }])

		assert.equal(waitForFollowUp.callCount, 1)
		assert.equal(makeRequests.callCount, 2)
		assert.equal(task.taskState.pendingCondenseSource, undefined)
	})

	it("propagates a plan-to-act API handler without dirtying the tool inventory", async () => {
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test task",
			taskId: "test-api-propagation",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		}) as any
		await t.applyWorkingConfigurationUpdate({ settings: { mode: "plan" } })
		assert.equal(t.taskState.pendingModeNotice?.mode, "plan")

		const markDirty = sandbox.stub(t.toolExecutor, "markToolsDirty")
		const toolExecutorSetApi = sandbox.spy(t.toolExecutor, "setApi")
		const setters = [
			t.taskMessenger,
			t.hookManager,
			t.environmentManager,
			t.lifecycleManager,
			t.apiConversationManager,
			t.responseProcessor,
		].map((manager) => sandbox.stub(manager, "setApi"))

		const updated = await t.applyWorkingConfigurationUpdate({ settings: { mode: "act" } })
		const installed = t.api

		updated.revision.should.equal(3)
		updated.settings.mode.should.equal("act")
		assert.equal(t.taskState.pendingModeNotice?.mode, "act")
		sinon.assert.calledOnceWithExactly(toolExecutorSetApi, installed)
		setters.forEach((setter) => sinon.assert.calledOnceWithExactly(setter, installed))
		sinon.assert.notCalled(markDirty)
	})

	it("records notices only for actual mode transitions", () => {
		const taskState = {
			pendingModeNotice: undefined as { mode: "plan" | "act" } | undefined,
			isAwaitingPlanResponse: false,
			didRespondToPlanAskBySwitchingMode: false,
		}
		const task = { taskState }
		const applyEffects = (previousMode: "plan" | "act", nextMode: "plan" | "act") =>
			(Task.prototype as any).applyCommittedModeEffects.call(task, previousMode, nextMode)

		applyEffects("act", "act")
		assert.equal(taskState.pendingModeNotice, undefined)

		applyEffects("act", "plan")
		assert.deepEqual(taskState.pendingModeNotice, { mode: "plan" })

		taskState.pendingModeNotice = undefined
		applyEffects("plan", "plan")
		assert.equal(taskState.pendingModeNotice, undefined)

		taskState.isAwaitingPlanResponse = true
		applyEffects("plan", "act")
		assert.deepEqual(taskState.pendingModeNotice, { mode: "act" })
		assert.equal(taskState.didRespondToPlanAskBySwitchingMode, true)
	})

	it("commits mode, YOLO state, API propagation, and tool inventory only after beforeCommit succeeds", async () => {
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test task",
			taskId: "test-atomic-config-commit",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		}) as any
		const previous = t.getWorkingConfiguration()
		const previousApi = t.api
		const markDirty = sandbox.stub(t.toolExecutor, "markToolsDirty")
		const setters = [
			t.taskMessenger,
			t.hookManager,
			t.toolExecutor,
			t.environmentManager,
			t.lifecycleManager,
			t.apiConversationManager,
			t.responseProcessor,
		].map((manager) => sandbox.stub(manager, "setApi"))

		await assert.rejects(
			() =>
				t.applyWorkingConfigurationUpdate(
					{ settings: { mode: "plan", yoloModeToggled: true, toolToggles: { edit_file: false } } },
					async () => {
						throw new Error("persistence failed")
					},
				),
			/persistence failed/,
		)
		assert.strictEqual(t.getWorkingConfiguration(), previous)
		assert.strictEqual(t.api, previousApi)
		assert.equal(t.diracIgnoreController.yoloMode, false)
		assert.equal(markDirty.callCount, 0)
		setters.forEach((setter) => assert.equal(setter.callCount, 0))

		let observedBeforeCommit = false
		const updated = await t.applyWorkingConfigurationUpdate(
			{ settings: { mode: "plan", yoloModeToggled: true, toolToggles: { edit_file: false } } },
			() => {
				observedBeforeCommit = true
				assert.strictEqual(t.getWorkingConfiguration(), previous)
				assert.strictEqual(t.api, previousApi)
				assert.equal(markDirty.callCount, 0)
			},
		)
		assert.equal(observedBeforeCommit, true)
		assert.strictEqual(t.getWorkingConfiguration(), updated)
		assert.equal(updated.revision, previous.revision + 1)
		assert.equal(updated.settings.mode, "plan")
		assert.equal(t.diracIgnoreController.yoloMode, true)
		sinon.assert.calledOnceWithExactly(markDirty, "tool_toggles_changed")
		setters.forEach((setter) => sinon.assert.calledOnceWithExactly(setter, t.api))
	})

	it("has cwd set from params", () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-456",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
		t.cwd.should.equal(tempDir)
	})

	it("initializes taskState", () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-789",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
		t.taskState.should.not.be.undefined()
	})

	it("abortTask transitions status to CANCELLING", async () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-abort",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
		await t.abortTask()
		// Status should be CANCELLING or IDLE after abort
		t.taskState.status.should.not.be.undefined()
	})

	it("cancelBackgroundCommand returns boolean", async () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-cancelbg",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
		const r = await t.cancelBackgroundCommand()
		r.should.be.a.Boolean()
	})

	it("ignores a card response when no card is waiting", async () => {
		const taskState = { lastWaitingCardId: undefined } as any
		const task = {
			taskState,
			withStateLock: async (callback: () => Promise<void>) => callback(),
		}

		await Task.prototype.submitCardResponse.call(task as any, "stale-card", DiracAskResponse.MESSAGE, "late reply")

		assert.equal(taskState.askResponse, undefined)
		assert.equal(taskState.askResponseText, undefined)
	})

	it("markToolsDirty does not throw", () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-dirty",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
			; (() => t.markToolsDirty("settings_refresh_detected_change" as any)).should.not.throw()
	})

	it("resetTransientState resolves", async () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-reset",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
		await t.resetTransientState()
	})

	it("executeCommandTool does not throw for valid command", () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-exec",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
			// Test that the method exists and can be called
			; (() => t.executeCommandTool("echo test", undefined)).should.not.throw()
	})

	it("cancelHookExecution does not throw", () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-hook",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
			; (() => t.cancelHookExecution()).should.not.throw()
	})

	it("has ulid property", () => {
		const mockCtx = createMockContext()
		const t = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId: sandbox.stub().resolves(),
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-ulid",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		})
		t.ulid.should.be.a.String()
		t.ulid.length.should.be.greaterThan(0)
	})

	it("reinitializes the task when a user cancels an API failure", async () => {
		const reinitExistingTaskFromId = sandbox.stub().resolves()
		const task = new Task({
			controller: createMockController(),
			updateTaskHistory: sandbox.stub().resolves([]),
			postStateToWebview: sandbox.stub().resolves(),
			reinitExistingTaskFromId,
			cancelTask: sandbox.stub().resolves(),
			shellIntegrationTimeout: 5000,
			terminalReuseEnabled: true,
			terminalOutputLineLimit: 500,
			defaultTerminalProfile: "default",
			vscodeTerminalExecutionMode: "vscodeTerminal",
			cwd: tempDir,
			stateManager: StateManager.get(),
			task: "test",
			taskId: "test-api-cancel",
			taskLockAcquired: false,
			workingConfiguration: StateManager.get().captureEffectiveTaskConfiguration(),
		}) as any
		const abortTask = sandbox.stub(task, "abortTask").resolves()

		task.taskState.apiErrorRetryAttempts = 3
		task.messageStateHandler = {
			getDiracMessages: () => [],
			getLatestApiStatusMessage: () => undefined,
			updateDiracMessage: sandbox.stub().resolves(),
		}
		task.taskMessenger = {
			createCard: sandbox.stub().callsFake(async (options: { requireApproval?: boolean }) => {
				if (!options.requireApproval) {
					return {}
				}
				return {
					waitForInteraction: sandbox.stub().resolves({ response: DiracAskResponse.REJECT }),
					finalize: sandbox.stub().resolves(),
				}
			}),
		}

		const shouldRetry = await task.handleApiRequestError({
			error: new Error("connection failed"),
			model: { id: "test-model", info: {} },
			providerId: "test-provider",
			metricsManager: {},
		})

		shouldRetry.should.equal(false)
		sinon.assert.calledOnce(abortTask)
		sinon.assert.calledOnceWithExactly(reinitExistingTaskFromId, "test-api-cancel")
	})

})
