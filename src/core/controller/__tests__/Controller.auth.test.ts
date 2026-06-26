/**
 * Characterization tests for Auth delegate methods extracted from Controller.
 * Captures current behavior of completeOpenRouterAuth, completeGithubLogin, completeRequestyAuth.
 */
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import * as skillsModule from "@core/context/instructions/user-instructions/skills"
import type { ApiConfiguration } from "@shared/api"
import axios from "axios"
import sinon from "sinon"
import { DiracEndpoint } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import * as githubCopilotAuthModule from "@/integrations/github-copilot/auth"
import { BannerService } from "@/services/banner/BannerService"
import type { DiracExtensionContext } from "@/shared/dirac"
import * as pathUtils from "@/utils/path"
import { StateManager } from "../../storage/StateManager"
import { Controller } from "../index"

describe("Controller — Auth delegate", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let mockContext: DiracExtensionContext
	let globalState: Record<string, any>
	let globalSettings: Record<string, any>
	let controller: Controller

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = `/tmp/dirac-test-auth-${Date.now()}`
		await DiracEndpoint.initialize(tempDir)
		sandbox.stub(pathUtils, "getCwd").resolves(tempDir)
		sandbox.stub(skillsModule, "getOrDiscoverSkills").resolves([])
		sandbox.stub(githubCopilotAuthModule, "githubCopilotAuthManager").value({
			initiateDeviceFlow: sandbox.stub().resolves({
				user_code: "ABC123",
				verification_uri: "https://example.com/claim",
				device_code: "code",
				interval: 5,
			}),
			pollForToken: sandbox.stub().resolves(),
			isAuthenticated: sandbox.stub().resolves(false),
			getEmail: sandbox.stub().resolves(undefined),
		})
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
		sandbox.stub(HostProvider, "window" as any).value({ showMessage: sandbox.stub() })

		const mockWatcher = { on: sandbox.stub(), close: sandbox.stub().resolves(), unref: sandbox.stub() }
		globalState = { taskHistory: [], mode: "plan", globalSkillsToggles: {}, localSkillsToggles: {} }
		globalSettings = { toolToggles: {} }
		sandbox.stub(StateManager, "get").returns({
			getGlobalSettingsKey: sandbox.stub().callsFake((k) => globalSettings[k] ?? undefined),
			getGlobalStateKey: sandbox.stub().callsFake((k) => globalState[k] ?? undefined),
			getWorkspaceStateKey: sandbox.stub().returns(undefined),
			setGlobalState: sandbox.stub().callsFake((k, v) => {
				globalState[k] = v
			}),
			setTaskSettingsBatch: sandbox.stub(),
			loadTaskSettings: sandbox.stub().resolves(),
			clearTaskSettings: sandbox.stub().resolves(),
			getApiConfiguration: sandbox.stub().returns({}),
			setApiConfiguration: sandbox.stub(),
			setSessionOverride: sandbox.stub(),
			getModelsCache: sandbox.stub().returns(null),
			registerCallbacks: sandbox.stub(),
		} as any)

		const mockBannerInstance = { getActiveBanners: sandbox.stub().returns([]), getWelcomeBanners: sandbox.stub().returns([]) }
		sandbox.stub(BannerService, "initialize").callsFake((ctrl) => {
			BannerService["instance"] = mockBannerInstance as any
			return mockBannerInstance as any
		})
		globalState = { taskHistory: [], mode: "plan" }
		globalSettings = {}
		mockContext = {
			extensionPath: tempDir,
			extensionUri: { fsPath: tempDir } as any,
			subscriptions: [],
			extensionMode: 1,
			globalState: { get: sandbox.stub(), update: sandbox.stub().resolves(), keys: sandbox.stub().returns([]) },
			workspaceState: { get: sandbox.stub(), update: sandbox.stub().resolves(), keys: sandbox.stub().returns([]) },
			secrets: {
				get: sandbox.stub().resolves(undefined),
				store: sandbox.stub().resolves(),
				delete: sandbox.stub().resolves(),
			},
			asAbsolutePath: (rel: string) => `/tmp/${rel}`,
		} as unknown as DiracExtensionContext
		controller = new Controller(mockContext)
	})

	afterEach(async () => {
		sandbox.restore()
		try {
			await require("fs/promises").rm(tempDir, { recursive: true, force: true })
		} catch {}
	})

	it("completeOpenRouterAuth exchanges code for API key and updates configuration", async () => {
		const currentConfig = { apiKey: "old-key" } as ApiConfiguration
		;(controller as any).stateManager.getApiConfiguration = sandbox.stub().returns(currentConfig)
		sandbox.stub(axios, "post").resolves({ data: { key: "new-openrouter-key-123" } })
		await controller.completeOpenRouterAuth("auth-code-xyz")
		sandbox.assert.calledWith(
			(controller as any).stateManager.setApiConfiguration,
			sinon.match({
				apiKey: "old-key",
				openRouterApiKey: "new-openrouter-key-123",
				planModeApiProvider: "openrouter",
				actModeApiProvider: "openrouter",
			}),
		)
	})

	it("completeOpenRouterAuth throws on invalid API response", async () => {
		sandbox.stub(axios, "post").resolves({ data: {} })
		await controller.completeOpenRouterAuth("bad-code").should.be.rejected()
	})

	it("completeRequestyAuth sets requesty API key in configuration", async () => {
		const currentConfig = { apiKey: "old-key" } as ApiConfiguration
		;(controller as any).stateManager.getApiConfiguration = sandbox.stub().returns(currentConfig)
		await controller.completeRequestyAuth("requesty-api-key-456")
		sandbox.assert.calledWith(
			(controller as any).stateManager.setApiConfiguration,
			sinon.match({
				apiKey: "old-key",
				requestyApiKey: "requesty-api-key-456",
				planModeApiProvider: "requesty",
				actModeApiProvider: "requesty",
			}),
		)
	})

	it("completeGithubLogin initiates device flow and starts polling", async () => {
		const stub = (githubCopilotAuthModule.githubCopilotAuthManager as any).initiateDeviceFlow
		stub.resolves({ user_code: "XYZ789", verification_uri: "https://claim.example.com", device_code: "dc", interval: 10 })
		await controller.completeGithubLogin()
		sandbox.assert.called(stub)
	})

	it("completeGithubLogin shows error message on failure", async () => {
		const stub = (githubCopilotAuthModule.githubCopilotAuthManager as any).initiateDeviceFlow
		stub.rejects(new Error("network error"))
		await controller.completeGithubLogin()
		sandbox.assert.calledWith((HostProvider.window as any).showMessage, {
			type: 0,
			message: "GitHub Copilot login failed: network error",
		})
	})
})
