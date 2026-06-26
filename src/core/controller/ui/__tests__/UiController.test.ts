/**
 * Characterization tests for getStateToPostToWebview state assembly.
 * Verifies that model state, auth state, telemetry state, and UI state are
 * correctly gathered from StateManager and external sources into ExtensionState.
 */

import * as skillsModule from "@core/context/instructions/user-instructions/skills"
import * as registryRefresh from "@core/task/tools/registry/refreshToolRegistry"
import * as ToolRegistryModule from "@core/task/tools/registry/ToolRegistry"
// Modules stubbed via their exported namespace (ts-node/commonjs keeps live bindings)
import * as workspaceSetup from "@core/workspace/setup"
import { TaskStatus } from "@shared/ExtensionMessage"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import * as configModule from "@/config"
import * as githubCopilotAuth from "@/integrations/github-copilot/auth"
import * as openaiCodexOauth from "@/integrations/openai-codex/oauth"
import * as BannerServiceModule from "@/services/banner/BannerService"
import * as featureFlagsIndex from "@/services/feature-flags"
import * as distinctIdModule from "@/services/logging/distinctId"
import * as announcementsModule from "@/utils/announcements"
import { StateManager } from "@core/storage/StateManager"
import { getStateToPostToWebview } from "../UiController"

type StateManagerLike = any

/** Build a fake StateManager returning sensible defaults; override per-key via maps. */
function makeFakeStateManager(overrides?: {
	apiConfiguration?: any
	globalState?: Record<string, any>
	globalSettings?: Record<string, any>
	workspaceState?: Record<string, any>
	modelsCache?: Record<string, any>
}): StateManagerLike {
	const globalState: Record<string, any> = {
		lastShownAnnouncementId: "ann-1",
		taskHistory: [],
		favoritedModelIds: [],
		lastDismissedInfoBannerVersion: 0,
		lastDismissedModelBannerVersion: 0,
		lastDismissedCliBannerVersion: 0,
		terminalReuseEnabled: false,
		vscodeTerminalExecutionMode: "default",
		isNewUser: true,
		welcomeViewCompleted: false,
		remoteRulesToggles: {},
		remoteWorkflowToggles: {},
		multiRootEnabled: true,
		...overrides?.globalState,
	}
	const globalSettings: Record<string, any> = {
		autoApprovalSettings: {},
		browserSettings: {},
		preferredLanguage: "en",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		autoApproveAllToggled: false,
		useAutoCondense: false,
		subagentsEnabled: false,
		telemetrySetting: "unset",
		planActSeparateModelsSetting: false,
		enableCheckpointsSetting: true,
		globalDiracRulesToggles: {},
		globalWorkflowToggles: {},
		globalSkillsToggles: {},
		shellIntegrationTimeout: 5000,
		defaultTerminalProfile: undefined,
		customPrompt: undefined,
		terminalOutputLineLimit: 500,
		maxConsecutiveMistakes: 3,
		doubleCheckCompletionEnabled: false,
		toolToggles: {},
		hooksEnabled: true,
		enableParallelToolCalling: false,
		backgroundEditEnabled: false,
		optOutOfRemoteConfig: false,
		diracWebToolsEnabled: false,
		worktreesEnabled: false,
		...overrides?.globalSettings,
	}
	const workspaceState: Record<string, any> = {
		localSkillsToggles: {},
		localDiracRulesToggles: {},
		localWindsurfRulesToggles: {},
		localCursorRulesToggles: {},
		localAgentsRulesToggles: {},
		workflowToggles: {},
		...overrides?.workspaceState,
	}
	return {
		getApiConfiguration: sinon.stub().returns(overrides?.apiConfiguration ?? { apiProvider: "anthropic" }),
		getGlobalStateKey: sinon.stub().callsFake((key: string) => globalState[key]),
		getGlobalSettingsKey: sinon.stub().callsFake((key: string) => globalSettings[key]),
		getWorkspaceStateKey: sinon.stub().callsFake((key: string) => workspaceState[key]),
		getModelsCache: sinon.stub().returns(overrides?.modelsCache ?? null),
	}
}

/** A fake task object satisfying the subset of Task used by getStateToPostToWebview. */
function makeFakeTask(overrides?: { taskId?: string; cwd?: string; diracMessages?: any[]; taskState?: any }): any {
	return {
		taskId: overrides?.taskId,
		cwd: overrides?.cwd ?? "/test/workspace",
		taskState: {
			status: TaskStatus.IDLE,
			isApiRequestActive: false,
			activeVoiceStreamId: undefined,
			checkpointManagerErrorMessage: undefined,
			...overrides?.taskState,
		},
		messageStateHandler: {
			getDiracMessages: () => overrides?.diracMessages ?? [],
		},
	}
}

function makeFakeWorkspaceManager(roots: string[] = ["/test/workspace"]): any {
	return {
		getPrimaryRoot: () => (roots[0] ? { path: roots[0] } : undefined),
		getRoots: () => roots.map((p) => ({ path: p })),
		getPrimaryIndex: () => 0,
	}
}

describe("getStateToPostToWebview", () => {
	let sandbox: sinon.SinonSandbox
	let codexIsAuthStub: sinon.SinonStub
	let codexEmailStub: sinon.SinonStub
	let copilotIsAuthStub: sinon.SinonStub
	let copilotEmailStub: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()

		// Static-import stubs
		sandbox.stub(workspaceSetup, "setupWorkspaceManager").resolves(makeFakeWorkspaceManager())
		sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves([])
		sandbox.stub(registryRefresh, "refreshToolRegistryForWorkspace").resolves()
		sandbox.stub(ToolRegistryModule.ToolRegistry, "getInstance").returns({
			getAllTools: () => [],
		} as any)
		sandbox.stub(BannerServiceModule.BannerService, "get").returns({
			getActiveBanners: () => [],
			getWelcomeBanners: () => [],
		} as any)
		sandbox.stub(featureFlagsIndex, "featureFlagsService").value({
			getWebtoolsEnabled: () => true,
			getWorktreesEnabled: () => false,
		} as any)
		sandbox.stub(distinctIdModule, "getDistinctId").returns("test-distinct-id")
		sandbox.stub(configModule.DiracEnv, "config").returns({ environment: "development" } as any)
		sandbox.stub(StateManager, "isInitialized").returns(true)
		copilotIsAuthStub = sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "isAuthenticated").resolves(false)
		copilotEmailStub = sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "getEmail").resolves(null)

		// Dynamic-import stubs (require returns the cached module object)
		sandbox.stub(announcementsModule, "getLatestAnnouncementId").returns("ann-2")
		codexIsAuthStub = sandbox.stub().resolves(false)
		codexEmailStub = sandbox.stub().resolves(null)
		sandbox.stub(openaiCodexOauth, "openAiCodexOAuthManager").value({
			isAuthenticated: codexIsAuthStub,
			getEmail: codexEmailStub,
		})
	})

	afterEach(() => sandbox.restore())

	describe("model state assembly", () => {
		it("passes apiConfiguration from stateManager through to the returned state", async () => {
			const apiConfig = { apiProvider: "openrouter", openRouterApiKey: "k" }
			const stateManager = makeFakeStateManager({ apiConfiguration: apiConfig })
			const state = await getStateToPostToWebview({
				stateManager,
				backgroundCommandRunning: false,
			})
			expect(state.apiConfiguration).to.deep.equal(apiConfig)
		})

		it("maps planActSeparateModelsSetting and enableCheckpointsSetting from settings", async () => {
			const stateManager = makeFakeStateManager({
				globalSettings: { planActSeparateModelsSetting: true, enableCheckpointsSetting: false },
			})
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.planActSeparateModelsSetting).to.equal(true)
			expect(state.enableCheckpointsSetting).to.equal(false)
		})

		it("defaults enableCheckpointsSetting to true when setting is undefined", async () => {
			const stateManager = makeFakeStateManager()
			stateManager.getGlobalSettingsKey = sinon
				.stub()
				.callsFake((key: string) => (key === "enableCheckpointsSetting" ? undefined : {}))
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.enableCheckpointsSetting).to.equal(true)
		})

		it("maps favoritedModelIds from global state", async () => {
			const stateManager = makeFakeStateManager({ globalState: { favoritedModelIds: ["m1", "m2"] } })
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.favoritedModelIds).to.deep.equal(["m1", "m2"])
		})
	})

	describe("auth state assembly", () => {
		it("surfaces openAiCodex authentication status and email", async () => {
			codexIsAuthStub.resolves(true)
			codexEmailStub.resolves("codex@user.com")

			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.openAiCodexIsAuthenticated).to.equal(true)
			expect(state.openAiCodexEmail).to.equal("codex@user.com")
		})

		it("surfaces githubCopilot authentication status, email, and cached models", async () => {
			copilotIsAuthStub.resolves(true)
			copilotEmailStub.resolves("copilot@user.com")
			codexIsAuthStub.resolves(false)
			codexEmailStub.resolves(null)

			const cachedModels = { "gpt-4": { name: "GPT-4" } }
			const stateManager = makeFakeStateManager({ modelsCache: cachedModels })
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.githubCopilotIsAuthenticated).to.equal(true)
			expect(state.githubCopilotEmail).to.equal("copilot@user.com")
			expect(state.githubCopilotModels).to.deep.equal(cachedModels)
		})

		it("yields undefined githubCopilotModels when cache is null", async () => {
			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.githubCopilotModels).to.equal(undefined)
		})
	})

	describe("telemetry state assembly", () => {
		it("maps telemetrySetting from global settings", async () => {
			const stateManager = makeFakeStateManager({ globalSettings: { telemetrySetting: "enabled" } })
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.telemetrySetting).to.equal("enabled")
		})

		it("maps distinctId from the logging service", async () => {
			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.distinctId).to.equal("test-distinct-id")
		})

		it("maps environment from DiracEnv config", async () => {
			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.environment).to.equal("development")
		})
	})

	describe("UI state assembly", () => {
		it("maps backgroundCommandRunning and backgroundCommandTaskId from deps", async () => {
			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({
				stateManager,
				backgroundCommandRunning: true,
				backgroundCommandTaskId: "bg-1",
			})
			expect(state.backgroundCommandRunning).to.equal(true)
			expect(state.backgroundCommandTaskId).to.equal("bg-1")
		})

		it("computes shouldShowAnnouncement when lastShown differs from latest", async () => {
			const stateManager = makeFakeStateManager({ globalState: { lastShownAnnouncementId: "ann-1" } })
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.shouldShowAnnouncement).to.equal(true)
		})

		it("computes shouldShowAnnouncement false when lastShown equals latest", async () => {
			sandbox.restore()
			sandbox = sinon.createSandbox()
			sandbox.stub(workspaceSetup, "setupWorkspaceManager").resolves(makeFakeWorkspaceManager())
			sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves([])
			sandbox.stub(registryRefresh, "refreshToolRegistryForWorkspace").resolves()
			sandbox.stub(ToolRegistryModule.ToolRegistry, "getInstance").returns({ getAllTools: () => [] } as any)
			sandbox.stub(BannerServiceModule.BannerService, "get").returns({
				getActiveBanners: () => [],
				getWelcomeBanners: () => [],
			} as any)
			sandbox.stub(featureFlagsIndex, "featureFlagsService").value({
				getWebtoolsEnabled: () => true,
				getWorktreesEnabled: () => false,
			} as any)
			sandbox.stub(distinctIdModule, "getDistinctId").returns("test-distinct-id")
			sandbox.stub(configModule.DiracEnv, "config").returns({ environment: "development" } as any)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "isAuthenticated").resolves(false)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "getEmail").resolves(null)
			sandbox.stub(announcementsModule, "getLatestAnnouncementId").returns("ann-1")
			sandbox.stub(openaiCodexOauth, "openAiCodexOAuthManager").value({
				isAuthenticated: sandbox.stub().resolves(false),
				getEmail: sandbox.stub().resolves(null),
			})

			const stateManager = makeFakeStateManager({ globalState: { lastShownAnnouncementId: "ann-1" } })
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.shouldShowAnnouncement).to.equal(false)
		})

		it("projects taskStatus from task state, defaulting to IDLE", async () => {
			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.taskStatus).to.equal(TaskStatus.IDLE)
		})

		it("projects taskStatus from an active task", async () => {
			const stateManager = makeFakeStateManager()
			const task = makeFakeTask({ taskState: { status: TaskStatus.STREAMING_TEXT } })
			const state = await getStateToPostToWebview({
				stateManager,
				task,
				backgroundCommandRunning: false,
			})
			expect(state.taskStatus).to.equal(TaskStatus.STREAMING_TEXT)
		})

		it("maps isApiRequestActive from task state, defaulting to false", async () => {
			const stateManager = makeFakeStateManager()
			const task = makeFakeTask({ taskState: { isApiRequestActive: true } })
			const state = await getStateToPostToWebview({
				stateManager,
				task,
				backgroundCommandRunning: false,
			})
			expect(state.isApiRequestActive).to.equal(true)
		})

		it("maps diracMessages from the task message state handler", async () => {
			const stateManager = makeFakeStateManager()
			const msgs = [{ id: "m1", content: { type: "markdown", content: "hi" } }]
			const task = makeFakeTask({ diracMessages: msgs })
			const state = await getStateToPostToWebview({
				stateManager,
				task,
				backgroundCommandRunning: false,
			})
			expect(state.diracMessages).to.deep.equal(msgs)
		})

		it("maps banners and welcomeBanners from BannerService", async () => {
			sandbox.restore()
			sandbox = sinon.createSandbox()
			sandbox.stub(workspaceSetup, "setupWorkspaceManager").resolves(makeFakeWorkspaceManager())
			sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves([])
			sandbox.stub(registryRefresh, "refreshToolRegistryForWorkspace").resolves()
			sandbox.stub(ToolRegistryModule.ToolRegistry, "getInstance").returns({ getAllTools: () => [] } as any)
			const banners = [{ bannerId: "b1", title: "Info" }] as any
			const welcomeBanners = [{ bannerId: "w1", title: "Welcome" }] as any
			sandbox.stub(BannerServiceModule.BannerService, "get").returns({
				getActiveBanners: () => banners,
				getWelcomeBanners: () => welcomeBanners,
			} as any)
			sandbox.stub(featureFlagsIndex, "featureFlagsService").value({
				getWebtoolsEnabled: () => true,
				getWorktreesEnabled: () => false,
			} as any)
			sandbox.stub(distinctIdModule, "getDistinctId").returns("test-distinct-id")
			sandbox.stub(configModule.DiracEnv, "config").returns({ environment: "development" } as any)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "isAuthenticated").resolves(false)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "getEmail").resolves(null)
			sandbox.stub(announcementsModule, "getLatestAnnouncementId").returns("ann-2")
			sandbox.stub(openaiCodexOauth, "openAiCodexOAuthManager").value({
				isAuthenticated: sandbox.stub().resolves(false),
				getEmail: sandbox.stub().resolves(null),
			})

			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.banners).to.deep.equal(banners)
			expect(state.welcomeBanners).to.deep.equal(welcomeBanners)
		})

		it("maps feature-flag-backed DiracFeatureSettings combining user setting and flag", async () => {
			const stateManager = makeFakeStateManager({
				globalSettings: { diracWebToolsEnabled: true, worktreesEnabled: false },
			})
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.diracWebToolsEnabled).to.deep.equal({ user: true, featureFlag: true })
			expect(state.worktreesEnabled).to.deep.equal({ user: false, featureFlag: false })
		})

		it("maps hooksEnabled via getHooksEnabledSafe, defaulting to true when undefined", async () => {
			const stateManager = makeFakeStateManager()
			stateManager.getGlobalSettingsKey = sinon.stub().callsFake((key: string) => (key === "hooksEnabled" ? undefined : {}))
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.hooksEnabled).to.equal(true)
		})
	})

	describe("task history processing", () => {
		it("filters out items missing ts or task, sorts descending, and caps at 100", async () => {
			const items = []
			for (let i = 0; i < 105; i++) {
				items.push({ id: `t${i}`, ts: i, task: "x", workspaceRootPath: "/test/workspace" })
			}
			// items missing required fields should be dropped
			items.push({ id: "bad1", ts: 1 } as any)
			items.push({ id: "bad2", task: "x" } as any)
			const stateManager = makeFakeStateManager({ globalState: { taskHistory: items } })
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.taskHistory).to.have.length(100)
			// sorted descending by ts -> first is the highest ts
			expect(state.taskHistory[0].ts).to.equal(104)
			expect(state.taskHistory[99].ts).to.equal(5)
		})

		it("filters task history by primary root when present", async () => {
			const items = [
				{ id: "t1", ts: 3, task: "x", workspaceRootPath: "/test/workspace" },
				{ id: "t2", ts: 2, task: "x", workspaceRootPath: "/other/workspace" },
				{ id: "t3", ts: 1, task: "x" }, // no root -> kept when primary exists
			]
			const stateManager = makeFakeStateManager({ globalState: { taskHistory: items } })
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			const ids = state.taskHistory.map((h: any) => h.id)
			expect(ids).to.deep.equal(["t1", "t3"])
		})

		it("resolves currentTaskItem from taskHistory matching task.taskId", async () => {
			const items = [
				{ id: "match", ts: 1, task: "x", workspaceRootPath: "/test/workspace" },
				{ id: "other", ts: 2, task: "x", workspaceRootPath: "/test/workspace" },
			]
			const stateManager = makeFakeStateManager({ globalState: { taskHistory: items } })
			const task = makeFakeTask({ taskId: "match" })
			const state = await getStateToPostToWebview({
				stateManager,
				task,
				backgroundCommandRunning: false,
			})
			expect(state.currentTaskItem?.id).to.equal("match")
		})
	})

	describe("workspace assembly", () => {
		it("uses provided workspaceManager when given", async () => {
			const wm = makeFakeWorkspaceManager(["/explicit"])
			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({
				stateManager,
				workspaceManager: wm,
				backgroundCommandRunning: false,
			})
			expect(state.workspaceRoots).to.deep.equal([{ path: "/explicit" }])
			expect(state.isMultiRootWorkspace).to.equal(false)
			expect((workspaceSetup.setupWorkspaceManager as sinon.SinonStub).called).to.equal(false)
		})

		it("detects multi-root workspace", async () => {
			sandbox.restore()
			sandbox = sinon.createSandbox()
			sandbox.stub(workspaceSetup, "setupWorkspaceManager").resolves(makeFakeWorkspaceManager(["/a", "/b"]))
			sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves([])
			sandbox.stub(registryRefresh, "refreshToolRegistryForWorkspace").resolves()
			sandbox.stub(ToolRegistryModule.ToolRegistry, "getInstance").returns({ getAllTools: () => [] } as any)
			sandbox.stub(BannerServiceModule.BannerService, "get").returns({
				getActiveBanners: () => [],
				getWelcomeBanners: () => [],
			} as any)
			sandbox.stub(featureFlagsIndex, "featureFlagsService").value({
				getWebtoolsEnabled: () => true,
				getWorktreesEnabled: () => false,
			} as any)
			sandbox.stub(distinctIdModule, "getDistinctId").returns("test-distinct-id")
			sandbox.stub(configModule.DiracEnv, "config").returns({ environment: "development" } as any)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "isAuthenticated").resolves(false)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "getEmail").resolves(null)
			sandbox.stub(announcementsModule, "getLatestAnnouncementId").returns("ann-2")
			sandbox.stub(openaiCodexOauth, "openAiCodexOAuthManager").value({
				isAuthenticated: sandbox.stub().resolves(false),
				getEmail: sandbox.stub().resolves(null),
			})

			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.isMultiRootWorkspace).to.equal(true)
			expect(state.workspaceRoots).to.have.length(2)
		})
	})

	describe("edge cases / defaults", () => {
		it("returns empty toggles when global/local rules toggles are undefined", async () => {
			const stateManager = makeFakeStateManager()
			stateManager.getGlobalSettingsKey = sinon
				.stub()
				.callsFake((key: string) => (key === "globalDiracRulesToggles" ? undefined : {}))
			stateManager.getWorkspaceStateKey = sinon
				.stub()
				.callsFake((key: string) => (key === "localDiracRulesToggles" ? undefined : {}))
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.globalDiracRulesToggles).to.deep.equal({})
			expect(state.localDiracRulesToggles).to.deep.equal({})
		})

		it("defaults lastDismissed banner versions to 0 when undefined", async () => {
			const stateManager = makeFakeStateManager()
			stateManager.getGlobalStateKey = sinon.stub().callsFake((key: string) => {
				if (key === "lastDismissedInfoBannerVersion") return undefined
				if (key === "taskHistory") return []
				return {}
			})
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.lastDismissedInfoBannerVersion).to.equal(0)
		})

		it("coerces welcomeViewCompleted to boolean", async () => {
			const stateManager = makeFakeStateManager()
			stateManager.getGlobalStateKey = sinon.stub().callsFake((key: string) => {
				if (key === "welcomeViewCompleted") return "truthy"
				if (key === "taskHistory") return []
				return {}
			})
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.welcomeViewCompleted).to.equal(true)
		})

		it("maps availableTools from the tool registry", async () => {
			sandbox.restore()
			sandbox = sinon.createSandbox()
			sandbox.stub(workspaceSetup, "setupWorkspaceManager").resolves(makeFakeWorkspaceManager())
			sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves([])
			sandbox.stub(registryRefresh, "refreshToolRegistryForWorkspace").resolves()
			const tools = [
				{ id: "read", name: "Read", source: "builtin", modulePath: "/p/read", spec: { description: "read file" } },
			]
			sandbox.stub(ToolRegistryModule.ToolRegistry, "getInstance").returns({ getAllTools: () => tools } as any)
			sandbox.stub(BannerServiceModule.BannerService, "get").returns({
				getActiveBanners: () => [],
				getWelcomeBanners: () => [],
			} as any)
			sandbox.stub(featureFlagsIndex, "featureFlagsService").value({
				getWebtoolsEnabled: () => true,
				getWorktreesEnabled: () => false,
			} as any)
			sandbox.stub(distinctIdModule, "getDistinctId").returns("test-distinct-id")
			sandbox.stub(configModule.DiracEnv, "config").returns({ environment: "development" } as any)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "isAuthenticated").resolves(false)
			sandbox.stub(githubCopilotAuth.githubCopilotAuthManager, "getEmail").resolves(null)
			sandbox.stub(announcementsModule, "getLatestAnnouncementId").returns("ann-2")
			sandbox.stub(openaiCodexOauth, "openAiCodexOAuthManager").value({
				isAuthenticated: sandbox.stub().resolves(false),
				getEmail: sandbox.stub().resolves(null),
			})

			const stateManager = makeFakeStateManager()
			const state = await getStateToPostToWebview({ stateManager, backgroundCommandRunning: false })
			expect(state.availableTools).to.have.length(1)
			expect(state.availableTools[0]).to.include({ id: "read", name: "Read", description: "read file" })
		})
	})
})
