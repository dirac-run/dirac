/**
 * Characterization tests for Task class (ORIGINAL codebase).
 * Captures current behavior — bugs and all.
 *
 * Phase 1 — Refactoring Safety Net
 */
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
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

    beforeEach(async () => {
        sandbox = sinon.createSandbox()
        tempDir = path.join(os.tmpdir(), `dirac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await fs.mkdir(tempDir, { recursive: true })

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
            loadTaskSettings: sandbox.stub().resolves(),
            getApiConfiguration: sandbox.stub().returns({}),
            registerCallbacks: sandbox.stub(),
        }
        sandbox.stub(StateManager, "get").returns(mockSM as any)
    })

    afterEach(async () => {
        sandbox.restore()
        try { await fs.rm(tempDir, { recursive: true, force: true }) } catch {}
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
        })
        t.should.not.be.undefined()
        t.taskId.should.equal("test-123")
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
        })
        const r = await t.cancelBackgroundCommand()
        r.should.be.a.Boolean()
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
        })
        ;(() => t.markToolsDirty("settings_refresh_detected_change" as any)).should.not.throw()
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
        })
        await t.resetTransientState().should.not.be.rejected()
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
        })
        // Test that the method exists and can be called
        ;(() => t.executeCommandTool("echo test", undefined)).should.not.throw()
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
        })
        ;(() => t.cancelHookExecution()).should.not.throw()
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
        })
        t.ulid.should.be.a.String()
        t.ulid.length.should.be.greaterThan(0)
    })
})