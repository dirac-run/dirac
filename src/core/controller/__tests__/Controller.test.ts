/**
 * Characterization tests for Controller (ORIGINAL codebase).
 * Captures current behavior — bugs and all.
 *
 * Phase 0 — Refactoring Safety Net
 * Strict TDD: RED → GREEN → Refactor → GREEN
 */
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import * as skillsModule from "@core/context/instructions/user-instructions/skills"
import * as checkpointFactory from "@integrations/checkpoints/factory"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { DiracEndpoint } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import { BannerService } from "@/services/banner/BannerService"
import type { DiracExtensionContext } from "@/shared/dirac"
import { Session } from "@/shared/services/Session"
import * as pathUtils from "@/utils/path"
import { StateManager } from "../../storage/StateManager"
import { Task } from "../../task"
import { Controller } from "../index"
import { expectLoggerErrors } from "@/test/loggerGuard"

describe("Controller (original)", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let mockContext: DiracExtensionContext
	let mockWatcherFactory: sinon.SinonStub

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = path.join(os.tmpdir(), `dirac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })
		await DiracEndpoint.initialize(tempDir)
		sandbox.stub(pathUtils, "getCwd").resolves(tempDir)

		// Mock chokidar watcher — prevents EPERM in sandbox
		const mockWatcher = { on: sandbox.stub(), close: sandbox.stub().resolves(), unref: sandbox.stub() }
		mockWatcherFactory = sandbox.stub().returns(mockWatcher)

		// Stub checkpoint manager factory — prevents Task constructor crash
		sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves([])

		sandbox.stub(checkpointFactory, "buildCheckpointManager").returns({
			initialize: sandbox.stub().resolves(),
			save: sandbox.stub().resolves(),
			restore: sandbox.stub().resolves(),
			getCheckpoints: sandbox.stub().returns([]),
		} as any)

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
			showMessage: sandbox.stub(),
		})

		sandbox.stub(Session, "get").returns({ reset: sandbox.stub() } as any)
		sandbox.stub(Session, "reset")
		sandbox.stub(BannerService, "initialize").returns({} as any)
		sandbox.stub(BannerService, "get").returns({
			getActiveBanners: sandbox.stub().returns([]),
			getWelcomeBanners: sandbox.stub().returns([]),
		} as any)

		// Mutable backing store so setters affect getters
		const globalState: Record<string, any> = {
			taskHistory: [],
			diracRules: "/mock/dirac/rules",
			mode: "plan",
			isNewUser: false,
			globalSkillsToggles: {},
			localSkillsToggles: {},
			globalDiracRulesToggles: {},
			globalWorkflowToggles: {},
			remoteRulesToggles: {},
			remoteWorkflowToggles: {},
			dismissedBanners: [],
			favoritedModelIds: [],
		}
		const globalSettings: Record<string, any> = {
			autoApprovalSettings: {},
			browserSettings: {},
			toolToggles: {},
			telemetrySetting: "disabled",
			planActSeparateModelsSetting: false,
			enableCheckpointsSetting: false,
			shellIntegrationTimeout: 5000,
			terminalOutputLineLimit: 500,
			maxConsecutiveMistakes: 3,
			doubleCheckCompletionEnabled: false,
			useAutoCondense: false,
			subagentsEnabled: false,
			preferredLanguage: "en",
			yoloModeToggled: false,
			autoApproveAllToggled: false,
			strictPlanModeEnabled: false,
			defaultTerminalProfile: "default",
		}
		const mockSM = {
			getGlobalSettingsKey: sandbox.stub().callsFake((key: string) => globalSettings[key] ?? undefined),
			getGlobalStateKey: sandbox.stub().callsFake((key: string) => globalState[key] ?? undefined),
			getWorkspaceStateKey: sandbox.stub().returns(undefined),
			setGlobalState: sandbox.stub().callsFake((key: string, value: any) => {
				globalState[key] = value
			}),
			setGlobalStateBatch: sandbox.stub().callsFake((updates: Record<string, any>) => {
				Object.assign(globalState, updates)
			}),
			setTaskSettingsBatch: sandbox.stub(),
			loadTaskSettings: sandbox.stub().resolves(),
			clearTaskSettings: sandbox.stub().resolves(),
			getApiConfiguration: sandbox.stub().returns({}),
			setApiConfiguration: sandbox.stub(),
			setSessionOverride: sandbox.stub(),
			getModelsCache: sandbox.stub().returns(null),
			setModelsCache: sandbox.stub(),
			registerCallbacks: sandbox.stub(),
			refreshModelProviderPresetsFromDisk: sandbox.stub(),
			flushPendingState: sandbox.stub().resolves(),
			getAllGlobalStateEntries: sandbox.stub().returns({}),
			getAllWorkspaceStateEntries: sandbox.stub().returns({}),
			getSecretKey: sandbox.stub().returns(undefined),
		}
		sandbox.stub(StateManager, "get").returns(mockSM as any)

		mockContext = {
			extensionPath: tempDir,
			extensionUri: { fsPath: tempDir } as any,
			subscriptions: [],
			extensionMode: 1,
			globalState: {
				get: sandbox.stub().returns(undefined),
				update: sandbox.stub().resolves(),
				keys: sandbox.stub().returns([]),
			},
			workspaceState: {
				get: sandbox.stub().returns(undefined),
				update: sandbox.stub().resolves(),
				keys: sandbox.stub().returns([]),
			},
			secrets: {
				get: sandbox.stub().resolves(undefined),
				store: sandbox.stub().resolves(),
				delete: sandbox.stub().resolves(),
			},
			asAbsolutePath: (rel: string) => path.join(tempDir, rel),
		} as unknown as DiracExtensionContext
	})

	afterEach(async () => {
		sandbox.restore()
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {}
	})

	// Helper: call initTask with mock watcher
	async function initTask(
		c: Controller,
		task?: string,
		images?: string[],
		files?: string[],
		hi?: any,
		ts?: any,
		cuid?: string,
	) {
		return c.initTask(task, images, files, hi, ts, cuid, mockWatcherFactory)
	}

	it("creates a Controller instance", () => {
		expectLoggerErrors()
		const c = new Controller(mockContext)
		c.should.be.instanceOf(Controller)
	})
	it("has a stateManager property", () => {
		expectLoggerErrors()
		const c = new Controller(mockContext)
		c.stateManager.should.not.be.undefined()
	})
	it("has no task initially", () => {
		expectLoggerErrors()
		const c = new Controller(mockContext)
		;(c.task === undefined).should.be.true()
	})
	it("initTask returns a string taskId", async () => {
		expectLoggerErrors()
		const c = new Controller(mockContext)
		const tid = await initTask(c, "test")
		tid.should.be.a.String()
		tid.length.should.be.greaterThan(0)
	})
	it("initTask creates a Task on controller.task", async () => {
		const c = new Controller(mockContext)
		await initTask(c, "test")
		;(c.task !== undefined).should.be.true()
	})
	it("dispose clears task", async () => {
		expectLoggerErrors()
		const c = new Controller(mockContext)
		await initTask(c, "test")
		await c.dispose()
		;(c.task === undefined).should.be.true()
	})
	it("clearTask nullifies controller.task", async () => {
		const c = new Controller(mockContext)
		await initTask(c, "test")
		await c.clearTask()
		;(c.task === undefined).should.be.true()
	})
	it("cancelTask resolves", async () => {
		const c = new Controller(mockContext)
		await initTask(c, "test")
		await c.cancelTask().should.not.be.rejected()
	})
	it("toggleActModeForYoloMode returns boolean", async () => {
		const c = new Controller(mockContext)
		const r = await c.toggleActModeForYoloMode()
		r.should.be.a.Boolean()
	})
	it("togglePlanActMode returns boolean", async () => {
		const c = new Controller(mockContext)
		await initTask(c, "test")
		const r = await c.togglePlanActMode("act")
		r.should.be.a.Boolean()
	})
	it("cancelBackgroundCommand resolves", async () => {
		const c = new Controller(mockContext)
		await c.cancelBackgroundCommand().should.not.be.rejected()
	})
	it("updateTaskHistory returns an array", async () => {
		const c = new Controller(mockContext)
		await initTask(c, "test")
		const item = { id: c.task!.taskId, ts: Date.now(), task: "test", ulid: c.task!.ulid }
		const r = await c.updateTaskHistory(item as any)
		r.should.be.an.Array()
	})
	it("getTaskWithId returns task details", async () => {
		const c = new Controller(mockContext)
		await initTask(c, "test")
		// Prime history + create expected file so getTaskWithId succeeds
		const item = { id: c.task!.taskId, ts: Date.now(), task: "test", ulid: c.task!.ulid }
		await c.updateTaskHistory(item as any)
		const taskDir = path.join(tempDir, "tasks", c.task!.taskId)
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, "api_conversation_history.json"), "[]", "utf8")
		const r = await c.getTaskWithId(c.task!.taskId)
		r.should.have.property("historyItem")
		r.should.have.property("taskDirPath")
	})
	it("deleteTaskFromState removes task", async () => {
		expectLoggerErrors()
		const c = new Controller(mockContext)
		await initTask(c, "test")
		const r = await c.deleteTaskFromState(c.task!.taskId)
		r.should.be.an.Array()
	})
	it("createTask creates task", async () => {
		const startTaskStub = sandbox.stub(Task.prototype, "startTask").resolves()
		const c = new Controller(mockContext)
		await c.createTask("test prompt").should.not.be.rejected()
		await c.taskRunPromise
		sinon.assert.calledOnceWithExactly(startTaskStub, "test prompt", undefined, undefined)
	})
	it("readOpenRouterModels returns undefined", async () => {
		const c = new Controller(mockContext)
		const m = await c.readOpenRouterModels()
		;(m === undefined).should.be.true()
	})
})
