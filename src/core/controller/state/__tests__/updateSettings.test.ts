import * as apiModule from "@core/api"
import { ToolRegistry } from "@core/task/tools/registry/ToolRegistry"
import * as telemetryModule from "@services/telemetry"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { Empty } from "@shared/proto/dirac/common"
import { ApiProvider } from "@shared/proto/dirac/models"
import {
	PlanActMode,
	UpdateSettingsRequest,
	UpdateSettingsRequestCli,
	UpdateTaskSettingsRequest,
} from "@shared/proto/dirac/state"
import * as conversionModule from "@shared/proto-conversions/models/api-configuration-conversion"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { DiracEnv } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { updateSettings } from "../updateSettings"
import { updateSettingsCli } from "../updateSettingsCli"
import { updateTaskSettings } from "../updateTaskSettings"

// Mock controller factory — builds a controller with a recording stateManager
function createMockController(overrides: any = {}) {
	const store: Record<string, any> = {
		__apiConfig: {
			planModeApiProvider: "anthropic",
			actModeApiProvider: "anthropic",
			planModeApiModelId: "claude-sonnet-4-20250514",
			actModeApiModelId: "claude-sonnet-4-20250514",
			mode: "act",
		},
	}
	const taskStore: Record<string, Record<string, any>> = {}
	const stateManager = {
		setGlobalState: sinon.spy((key: string, value: any) => {
			store[key] = value
		}),
		setGlobalStateBatch: sinon.spy((batch: any) => {
			Object.assign(store, batch)
		}),
		getGlobalSettingsKey: sinon.spy((key: string) => store[key]),
		getSystemDefaultSettingsKey: sinon.spy((key: string) => store[key]),
		getGlobalStateKey: sinon.spy((key: string) => store[key]),
		getSecretKey: sinon.spy((key: string) => store[key]),
		setSessionOverride: sinon.spy((key: string, value: any) => {
			store[`__override_${key}`] = value
		}),
		hasSessionOverride: sinon.spy((key: string) => Object.hasOwn(store, `__override_${key}`)),
		clearSessionOverride: sinon.spy((key: string) => {
			delete store[`__override_${key}`]
		}),
		setApiConfiguration: sinon.spy((config: any) => {
			store["__apiConfig"] = { ...(store["__apiConfig"] ?? {}), ...config }
			Object.assign(store, config)
		}),
		getApiConfiguration: sinon.spy(() => store["__apiConfig"] ?? {}),
		setTaskSettings: sinon.spy((taskId: string, key: string, value: any) => {
			if (!taskStore[taskId]) taskStore[taskId] = {}
			taskStore[taskId][key] = value
		}),
		setTaskSettingsBatch: sinon.spy((taskId: string, batch: any) => {
			if (!taskStore[taskId]) taskStore[taskId] = {}
			Object.assign(taskStore[taskId], batch)
		}),
		hasTaskSetting: sinon.spy((key: string) => Object.values(taskStore).some((settings) => Object.hasOwn(settings, key))),
		getTaskSetting: sinon.spy(
			(key: string) => Object.values(taskStore).find((settings) => Object.hasOwn(settings, key))?.[key],
		),
		clearTaskSetting: sinon.spy((taskId: string, key: string) => {
			if (taskStore[taskId]) delete taskStore[taskId][key]
		}),
		setSecretsBatch: sinon.spy((batch: any) => {
			Object.assign(store, batch)
		}),
		_store: store,
		_taskStore: taskStore,
	}

	const mockApi = { getModel: () => ({ id: "test-model-id" }) }
	const terminalManager = {
		setDefaultTerminalProfile: sinon.spy(() => ({ closedCount: 0, busyTerminals: [] })),
	}

	const controller: any = {
		stateManager,
		task: overrides.task ?? null,
		postStateToWebview: sinon.spy(async () => { }),
		updateTelemetrySetting: sinon.spy(async (_setting: any) => { }),
		markToolsDirty: sinon.spy(() => { }),
		...overrides,
	}

	if (controller.task) {
		let workingConfiguration: any = {
			revision: 1,
			settings: {
				mode: store.__apiConfig.mode ?? "act",
				hooksEnabled: store.hooksEnabled ?? true,
				subagentsEnabled: store.subagentsEnabled ?? false,
				planModeApiProvider: store.__apiConfig.planModeApiProvider,
				actModeApiProvider: store.__apiConfig.actModeApiProvider,
				autoApprovalSettings: store.autoApprovalSettings ?? {
					version: 1,
					enableNotifications: false,
					actions: {},
					favorites: [],
					maxRequests: 20,
				},
				browserSettings: store.browserSettings ?? DEFAULT_BROWSER_SETTINGS,
			},
			apiConfiguration: { ...store.__apiConfig },
			workspaceConfiguration: {},
			executionOptions: {
				terminalReuseEnabled: true,
				vscodeTerminalExecutionMode: "vscodeTerminal",
				multiRootEnabled: false,
			},
		}
		controller.task = {
			ulid: "test-ulid",
			taskId: "test-task-id",
			api: mockApi,
			terminalManager,
			getWorkingConfiguration: sinon.spy(() => workingConfiguration),
			applyWorkingConfigurationUpdate: sinon.spy(
				async (patch: any, beforeCommit?: (candidate: any) => void | Promise<void>) => {
					const resolvedPatch = typeof patch === "function" ? patch(workingConfiguration) : patch
					controller.task.lastAppliedPatch = resolvedPatch
					apiModule.buildApiHandler(
						{ ...workingConfiguration.apiConfiguration, ...resolvedPatch.apiConfiguration },
						resolvedPatch.settings?.mode ?? workingConfiguration.settings.mode,
					)
					const candidate = {
						...workingConfiguration,
						revision: workingConfiguration.revision + 1,
						settings: { ...workingConfiguration.settings, ...resolvedPatch.settings },
						apiConfiguration: { ...workingConfiguration.apiConfiguration, ...resolvedPatch.apiConfiguration },
					}
					await beforeCommit?.(candidate)
					workingConfiguration = candidate
					return workingConfiguration
				},
			),
			markToolsDirty: sinon.spy(() => { }),
			...controller.task,
		}
	}

	return controller
}

describe("updateSettings", () => {
	let sandbox: sinon.SinonSandbox
	let telemetrySpies: any
	let showMessageSpy: sinon.SinonSpy

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(Logger, "error")
		sandbox.stub(Logger, "log")
		sandbox.stub(DiracEnv, "setEnvironment")
		sandbox.stub(apiModule, "buildApiHandler").returns({} as any)
		sandbox.stub(conversionModule, "convertProtoToApiConfiguration").returns({
			planModeApiProvider: "anthropic",
			actModeApiProvider: "anthropic",
			planModeApiModelId: "claude-sonnet-4-20250514",
			actModeApiModelId: "claude-sonnet-4-20250514",
		} as any)
		sandbox.stub(conversionModule, "convertProtoToApiProvider").returns("anthropic")
		showMessageSpy = sinon.spy()
		sandbox.stub(HostProvider, "window").get(() => ({ showMessage: showMessageSpy }) as any)
		telemetrySpies = {
			captureYoloModeToggle: sinon.spy(),
			captureDiracWebToolsToggle: sinon.spy(),
			captureAutoCondenseToggle: sinon.spy(),
			captureSubagentToggle: sinon.spy(),
			captureFeatureToggle: sinon.spy(),
		}
		sandbox.stub(telemetryModule, "telemetryService").get(() => telemetrySpies)
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("global role catalog updates", () => {
		for (const client of ["webview", "cli"] as const) {
			it(`${client} persists roles without rebuilding an active Task`, async () => {
				const controller = createMockController({ task: {} })
				const before = controller.task.getWorkingConfiguration()
				const subagentRoles = { roles: [{ name: "Reviewer", description: "Review code.", enabled: false }] }
				if (client === "webview") await updateSettings(controller, UpdateSettingsRequest.create({ subagentRoles }))
				else await updateSettingsCli(controller, UpdateSettingsRequestCli.create({ settings: { subagentRoles } }))
				expect(controller.stateManager._store.subagentRoles).to.deep.equal(subagentRoles.roles)
				expect(controller.task.applyWorkingConfigurationUpdate.called).to.be.false
				expect((apiModule.buildApiHandler as sinon.SinonStub).called).to.be.false
				expect(controller.task.getWorkingConfiguration()).to.equal(before)
				expect(controller.postStateToWebview.calledOnce).to.be.true
			})

			it(`${client} keeps roles out of a mixed active-task settings patch`, async () => {
				const controller = createMockController({ task: {} })
				const settings = { subagentRoles: { roles: [] }, preferredLanguage: "French" }
				if (client === "webview") await updateSettings(controller, UpdateSettingsRequest.create(settings))
				else await updateSettingsCli(controller, UpdateSettingsRequestCli.create({ settings }))
				expect(controller.stateManager._store.subagentRoles).to.deep.equal([])
				expect(controller.task.lastAppliedPatch.settings).not.to.have.property("subagentRoles")
				expect(controller.task.lastAppliedPatch.settings.preferredLanguage).to.equal("French")
			})

			it(`${client} rejects invalid roles before changing settings`, async () => {
				const controller = createMockController({ task: {} })
				const settings = { subagentRoles: { roles: [{ name: "default", description: "Invalid.", enabled: false }] } }
				let error: unknown
				try {
					if (client === "webview") await updateSettings(controller, UpdateSettingsRequest.create(settings))
					else await updateSettingsCli(controller, UpdateSettingsRequestCli.create({ settings }))
				} catch (caught) { error = caught }
				expect(error).to.be.instanceOf(Error)
				expect(controller.stateManager._store).not.to.have.property("subagentRoles")
				expect(controller.task.applyWorkingConfigurationUpdate.called).to.be.false
			})
		}
	})

	describe("updateSettings (webview)", () => {
		it("should update diracEnv when provided", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ diracEnv: "staging" }))
			expect((DiracEnv.setEnvironment as sinon.SinonStub).calledWith("staging")).to.be.true
		})

		it("should not call setEnvironment when diracEnv is undefined", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({}))
			expect((DiracEnv.setEnvironment as sinon.SinonStub).called).to.be.false
		})

		it("should set apiConfiguration and rebuild api handler when task exists", async () => {
			const controller = createMockController({ task: {} })
			const request = UpdateSettingsRequest.create({ apiConfiguration: {} as any })
			await updateSettings(controller, request)
			expect(controller.stateManager.setApiConfiguration.calledOnce).to.be.true
			expect((apiModule.buildApiHandler as sinon.SinonStub).calledOnce).to.be.true
			expect(controller.task.applyWorkingConfigurationUpdate.calledOnce).to.be.true
		})

		it("should set apiConfiguration but not rebuild handler when no active task", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ apiConfiguration: {} as any }))
			expect(controller.stateManager.setApiConfiguration.calledOnce).to.be.true
			expect((apiModule.buildApiHandler as sinon.SinonStub).called).to.be.false
		})

		it("updates utility model settings in the active task transaction", async () => {
			const controller = createMockController({ task: {} })
			await updateSettings(
				controller,
				UpdateSettingsRequest.create({
					utilityModelEnabled: true,
					utilityModelSelection: {
						provider: ApiProvider.OPENAI,
						modelId: "gpt-5-mini",
						openAiProfileName: "utility-profile",
						awsBedrockCustomSelected: true,
						awsBedrockCustomModelBaseId: "base-model",
					},
				}),
			)

			expect(controller.stateManager.setGlobalState.calledWith("utilityModelEnabled", true)).to.be.true
			expect(
				controller.stateManager.setGlobalState.calledWith(
					"utilityModelSelection",
					sinon.match({
						provider: "openai",
						modelId: "gpt-5-mini",
						openAiProfileName: "utility-profile",
						awsBedrockCustomSelected: true,
						awsBedrockCustomModelBaseId: "base-model",
					}),
				),
			).to.be.true
			expect(controller.task.applyWorkingConfigurationUpdate.calledOnce).to.be.true
			expect(controller.task.lastAppliedPatch.settings).to.include({
				utilityModelEnabled: true,
			})
		})

		it("does not persist an invalid API configuration", async () => {
			const controller = createMockController({ task: {} })
				; (apiModule.buildApiHandler as sinon.SinonStub).throws(new Error("invalid candidate"))

			try {
				await updateSettings(controller, UpdateSettingsRequest.create({ apiConfiguration: {} as any }))
				expect.fail("Should have thrown")
			} catch (error: any) {
				expect(error.message).to.equal("invalid candidate")
			}
			expect(controller.stateManager.setApiConfiguration.called).to.be.false
			expect(controller.task.applyWorkingConfigurationUpdate.calledOnce).to.be.true
		})

		it("should call updateTelemetrySetting when telemetrySetting is provided", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ telemetrySetting: "enabled" }))
			expect(controller.updateTelemetrySetting.calledOnceWith("enabled")).to.be.true
		})

		it("should convert mode PLAN to 'plan' and set both global state and session override", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ mode: PlanActMode.PLAN }))
			expect(controller.stateManager.setGlobalState.calledWith("mode", "plan")).to.be.true
			expect(controller.stateManager.setSessionOverride.calledWith("mode", "plan")).to.be.true
		})

		it("should convert mode ACT to 'act'", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ mode: PlanActMode.ACT }))
			expect(controller.stateManager.setGlobalState.calledWith("mode", "act")).to.be.true
		})

		it("should convert shellIntegrationTimeout to Number", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ shellIntegrationTimeout: "5000" as any }))
			expect(controller.stateManager.setGlobalState.calledWith("shellIntegrationTimeout", 5000)).to.be.true
		})

		it("should convert terminalOutputLineLimit to Number", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ terminalOutputLineLimit: "200" as any }))
			expect(controller.stateManager.setGlobalState.calledWith("terminalOutputLineLimit", 200)).to.be.true
		})

		it("should convert maxConsecutiveMistakes to Number", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ maxConsecutiveMistakes: "3" as any }))
			expect(controller.stateManager.setGlobalState.calledWith("maxConsecutiveMistakes", 3)).to.be.true
		})

		it("should normalize vscodeTerminalExecutionMode to 'backgroundExec' when value is 'backgroundExec'", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ vscodeTerminalExecutionMode: "backgroundExec" }))
			expect(controller.stateManager.setGlobalState.calledWith("vscodeTerminalExecutionMode", "backgroundExec")).to.be.true
		})

		it("should normalize vscodeTerminalExecutionMode to 'vscodeTerminal' for any non-empty non-backgroundExec value", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ vscodeTerminalExecutionMode: "somethingElse" }))
			expect(controller.stateManager.setGlobalState.calledWith("vscodeTerminalExecutionMode", "vscodeTerminal")).to.be.true
		})

		it("should not update vscodeTerminalExecutionMode when empty string", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ vscodeTerminalExecutionMode: "" }))
			const calls = controller.stateManager.setGlobalState
				.getCalls()
				.filter((c: any) => c.args[0] === "vscodeTerminalExecutionMode")
			expect(calls.length).to.equal(0)
		})

		it("should coerce backgroundEditEnabled to boolean", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ backgroundEditEnabled: 1 as any }))
			expect(controller.stateManager.setGlobalState.calledWith("backgroundEditEnabled", true)).to.be.true
		})

		it("should coerce multiRootEnabled to boolean", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ multiRootEnabled: 0 as any }))
			expect(controller.stateManager.setGlobalState.calledWith("multiRootEnabled", false)).to.be.true
		})

		it("should set customPrompt to 'compact' when value is 'compact'", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ customPrompt: "compact" }))
			expect(controller.stateManager.setGlobalState.calledWith("customPrompt", "compact")).to.be.true
		})

		it("should set customPrompt to undefined when value is not 'compact'", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ customPrompt: "other" }))
			expect(controller.stateManager.setGlobalState.calledWith("customPrompt", undefined)).to.be.true
		})

		it("should merge browser settings with existing defaults preserving unspecified fields", async () => {
			const controller = createMockController()
			controller.stateManager._store["browserSettings"] = { ...DEFAULT_BROWSER_SETTINGS }
			const request = UpdateSettingsRequest.create({
				browserSettings: { viewport: { width: 1280, height: 800 }, remoteBrowserEnabled: true } as any,
			})
			await updateSettings(controller, request)
			const setCall = controller.stateManager.setGlobalState.getCalls().find((c: any) => c.args[0] === "browserSettings")
			const result = setCall.args[1]
			expect(result.viewport.width).to.equal(1280)
			expect(result.viewport.height).to.equal(800)
			expect(result.remoteBrowserEnabled).to.equal(true)
			expect(result.remoteBrowserHost).to.equal(DEFAULT_BROWSER_SETTINGS.remoteBrowserHost)
		})

		it("should use undefined chromeExecutablePath when not explicitly provided (protobuf sets key to undefined)", async () => {
			const controller = createMockController()
			controller.stateManager._store["browserSettings"] = {
				...DEFAULT_BROWSER_SETTINGS,
				chromeExecutablePath: "/usr/bin/chrome",
			}
			const request = UpdateSettingsRequest.create({ browserSettings: { viewport: { width: 100, height: 100 } } as any })
			await updateSettings(controller, request)
			const setCall = controller.stateManager.setGlobalState.getCalls().find((c: any) => c.args[0] === "browserSettings")
			// Protobuf-es always includes the key (set to undefined), so `in` check is always true
			expect(setCall.args[1].chromeExecutablePath).to.be.undefined
		})

		it("should use empty string chromeExecutablePath when explicitly in request", async () => {
			const controller = createMockController()
			controller.stateManager._store["browserSettings"] = {
				...DEFAULT_BROWSER_SETTINGS,
				chromeExecutablePath: "/usr/bin/chrome",
			}
			const request = UpdateSettingsRequest.create({ browserSettings: { chromeExecutablePath: "" } as any })
			await updateSettings(controller, request)
			const setCall = controller.stateManager.setGlobalState.getCalls().find((c: any) => c.args[0] === "browserSettings")
			expect(setCall.args[1].chromeExecutablePath).to.equal("")
		})

		it("should parse toolToggles JSON and load into ToolRegistry", async () => {
			const controller = createMockController({ task: {} })
			const registry = ToolRegistry.getInstance()
			const loadTogglesStub = sinon.stub(registry, "loadToggles")
			const getTogglesStub = sinon.stub(registry, "getToggles").returns({ readFiles: true })
			const toggles = { readFiles: true, upsert_tool: true }
			await updateSettings(controller, UpdateSettingsRequest.create({ toolToggles: JSON.stringify(toggles) }))
			expect(loadTogglesStub.calledWith(toggles)).to.be.true
			expect(getTogglesStub.called).to.be.true
			expect(controller.stateManager.setGlobalState.calledWith("toolToggles", { readFiles: true })).to.be.true
			expect(controller.task.applyWorkingConfigurationUpdate.calledOnce).to.be.true
			expect(controller.task.lastAppliedPatch.settings.toolToggles).to.deep.equal({
				readFiles: true,
			})
		})

		it("restores registry and persisted toggles when persistence throws after mutation", async () => {
			const controller = createMockController({ task: {} })
			const registry = ToolRegistry.getInstance()
				; (registry.loadToggles as sinon.SinonStub | undefined)?.restore?.()
				; (registry.getToggles as sinon.SinonStub | undefined)?.restore?.()
			registry.registerBuiltin({
				id: "edit_file" as any,
				name: "edit_file",
				source: "builtin",
				exposure: { kind: "configurable" },
				spec: { id: "edit_file" as any, name: "edit_file", description: "test" },
				factory: () => ({}) as any,
				modulePath: "/builtin/edit_file.ts",
			})
			registry.loadToggles({ edit_file: true })
			controller.stateManager._store.toolToggles = { edit_file: true }
			controller.stateManager.setGlobalState = sinon.stub()
			controller.stateManager.setGlobalState.onFirstCall().callsFake((key: string, value: any) => {
				controller.stateManager._store[key] = value
				throw new Error("toggle persistence failed")
			})
			controller.stateManager.setGlobalState.onSecondCall().callsFake((key: string, value: any) => {
				controller.stateManager._store[key] = value
			})

			await updateSettings(
				controller,
				UpdateSettingsRequest.create({ toolToggles: JSON.stringify({ edit_file: false }) }),
			).should.be.rejectedWith("toggle persistence failed")

			expect(registry.getToggles()).to.deep.equal({ edit_file: true })
			expect(controller.stateManager._store.toolToggles).to.deep.equal({ edit_file: true })
			expect(controller.task.markToolsDirty.called).to.be.false
		})

		it("should update default terminal profile and notify when terminals closed", async () => {
			const controller = createMockController({ task: {} })
			controller.task.terminalManager.setDefaultTerminalProfile = sinon.spy(() => ({ closedCount: 2, busyTerminals: [] }))
			await updateSettings(controller, UpdateSettingsRequest.create({ defaultTerminalProfile: "profile-1" }))
			expect(controller.stateManager.setGlobalState.calledWith("defaultTerminalProfile", "profile-1")).to.be.true
			expect(
				(HostProvider.window.showMessage as sinon.SinonSpy).calledWith(
					sinon.match({ type: ShowMessageType.INFORMATION }),
				),
			).to.be.true
		})

		it("should show warning when busy terminals have different profile", async () => {
			const controller = createMockController({ task: {} })
			controller.task.terminalManager.setDefaultTerminalProfile = sinon.spy(() => ({
				closedCount: 0,
				busyTerminals: [{ id: 1 }],
			}))
			await updateSettings(controller, UpdateSettingsRequest.create({ defaultTerminalProfile: "profile-1" }))
			expect((HostProvider.window.showMessage as sinon.SinonSpy).calledWith(sinon.match({ type: ShowMessageType.WARNING })))
				.to.be.true
		})

		it("should capture telemetry for hooks toggle when task exists and value changes", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._store["hooksEnabled"] = true
			await updateSettings(controller, UpdateSettingsRequest.create({ hooksEnabled: false }))
			expect(telemetrySpies.captureFeatureToggle.calledOnce).to.be.true
		})

		it("should not capture telemetry for hooks when value unchanged", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._store["hooksEnabled"] = true
			await updateSettings(controller, UpdateSettingsRequest.create({ hooksEnabled: true }))
			expect(telemetrySpies.captureFeatureToggle.called).to.be.false
		})

		it("should default hooksEnabled to true when no prior value exists", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({ hooksEnabled: false }))
			expect(controller.stateManager.setGlobalState.calledWith("hooksEnabled", false)).to.be.true
		})

		it("should capture subagent toggle telemetry only when value changes", async () => {
			const controller = createMockController()
			controller.stateManager._store["subagentsEnabled"] = false
			await updateSettings(controller, UpdateSettingsRequest.create({ subagentsEnabled: true }))
			expect(telemetrySpies.captureSubagentToggle.calledOnceWith(true)).to.be.true
		})

		it("should not capture subagent toggle when value unchanged", async () => {
			const controller = createMockController()
			controller.stateManager._store["subagentsEnabled"] = true
			await updateSettings(controller, UpdateSettingsRequest.create({ subagentsEnabled: true }))
			expect(telemetrySpies.captureSubagentToggle.called).to.be.false
		})

		it("should return Empty response on success", async () => {
			const controller = createMockController()
			const result = await updateSettings(controller, UpdateSettingsRequest.create({}))
			expect(result).to.deep.equal(Empty.create())
		})

		it("should call postStateToWebview after updates", async () => {
			const controller = createMockController()
			await updateSettings(controller, UpdateSettingsRequest.create({}))
			expect(controller.postStateToWebview.calledOnce).to.be.true
		})
	})

	describe("updateSettingsCli", () => {
		it("should set environment when provided", async () => {
			const controller = createMockController()
			await updateSettingsCli(controller, UpdateSettingsRequestCli.create({ environment: "production" }))
			expect((DiracEnv.setEnvironment as sinon.SinonStub).calledWith("production")).to.be.true
		})

		it("should batch update simple settings and exclude openaiReasoningEffort", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({
				settings: { preferredLanguage: "typescript", openAiBaseUrl: "http://localhost" } as any,
			})
			await updateSettingsCli(controller, request)
			expect(controller.stateManager.setGlobalStateBatch.calledOnce).to.be.true
			const batch = controller.stateManager.setGlobalStateBatch.firstCall.args[0]
			expect(batch.preferredLanguage).to.equal("typescript")
			expect(batch.openAiBaseUrl).to.equal("http://localhost")
			expect(batch.openaiReasoningEffort).to.be.undefined
		})

		it("should filter out undefined values from simple settings batch", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({
				settings: { preferredLanguage: undefined as any, openAiBaseUrl: "http://localhost" } as any,
			})
			await updateSettingsCli(controller, request)
			const batch = controller.stateManager.setGlobalStateBatch.firstCall.args[0]
			expect(batch.preferredLanguage).to.be.undefined
			expect(batch.openAiBaseUrl).to.equal("http://localhost")
		})

		it("should convert planModeApiProvider from proto to string", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({
				settings: { planModeApiProvider: ApiProvider.ANTHROPIC } as any,
			})
			await updateSettingsCli(controller, request)
			expect((conversionModule.convertProtoToApiProvider as sinon.SinonStub).calledOnce).to.be.true
			expect(controller.stateManager.setGlobalStateBatch.calledWithMatch({ planModeApiProvider: "anthropic" })).to.be.true
		})

		it("should convert actModeApiProvider from proto to string", async () => {
			; (conversionModule.convertProtoToApiProvider as sinon.SinonStub).returns("openai")
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({
				settings: { actModeApiProvider: ApiProvider.OPENAI } as any,
			})
			await updateSettingsCli(controller, request)
			expect(controller.stateManager.setGlobalStateBatch.calledWithMatch({ actModeApiProvider: "openai" })).to.be.true
		})

		it("converts and persists global Utility model settings from CLI protobuf values", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({
				settings: {
					utilityModelEnabled: true,
					utilityModelUsePermissionHandling: true,
					utilityModelPermissionPolicy: "Never allow network calls.",
					utilityModelSelection: {
						provider: ApiProvider.OPENAI,
						modelId: "gpt-5-mini",
						openAiProfileName: "utility-profile",
						awsBedrockCustomSelected: true,
						awsBedrockCustomModelBaseId: "base-model",
					},
				},
			})

			await updateSettingsCli(controller, request)

			const batch = controller.stateManager.setGlobalStateBatch.firstCall.args[0]
			expect(batch.utilityModelEnabled).to.equal(true)
			expect(batch.utilityModelUsePermissionHandling).to.equal(true)
			expect(batch.utilityModelPermissionPolicy).to.equal("Never allow network calls.")
			expect(batch.utilityModelSelection).to.deep.include({
				provider: "openai",
				modelId: "gpt-5-mini",
				openAiProfileName: "utility-profile",
				awsBedrockCustomSelected: true,
				awsBedrockCustomModelBaseId: "base-model",
			})
		})

		it("should set customPrompt to 'compact' only when value is 'compact'", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({ settings: { customPrompt: "compact" } as any })
			await updateSettingsCli(controller, request)
			expect(controller.stateManager.setGlobalStateBatch.calledWithMatch({ customPrompt: "compact" })).to.be.true
		})

		it("should not set customPrompt when value is not 'compact'", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({ settings: { customPrompt: "other" } as any })
			await updateSettingsCli(controller, request)
			const calls = controller.stateManager.setGlobalState.getCalls().filter((c: any) => c.args[0] === "customPrompt")
			expect(calls.length).to.equal(0)
		})

		it("should merge autoApprovalSettings preserving unspecified fields", async () => {
			const controller = createMockController()
			controller.stateManager._store["autoApprovalSettings"] = {
				version: 1,
				actions: { readFiles: true, editFiles: false },
				enableNotifications: false,
			}
			const request = UpdateSettingsRequestCli.create({
				settings: { autoApprovalSettings: { version: 2, actions: { editFiles: true } } as any } as any,
			})
			await updateSettingsCli(controller, request)
			const persisted = controller.stateManager.setGlobalStateBatch.firstCall.args[0].autoApprovalSettings
			expect(persisted.version).to.equal(2)
			expect(persisted.actions.readFiles).to.equal(true)
			expect(persisted.actions.editFiles).to.equal(true)
			expect(persisted.enableNotifications).to.equal(false)
		})

		it("should rebuild api handler when task exists after settings update", async () => {
			const controller = createMockController({ task: {} })
			const request = UpdateSettingsRequestCli.create({ settings: { preferredLanguage: "typescript" } as any })
			await updateSettingsCli(controller, request)
			expect((apiModule.buildApiHandler as sinon.SinonStub).calledOnce).to.be.true
			expect(controller.task.applyWorkingConfigurationUpdate.calledOnce).to.be.true
		})

		it("should not rebuild api handler when no active task", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({ settings: { preferredLanguage: "typescript" } as any })
			await updateSettingsCli(controller, request)
			expect((apiModule.buildApiHandler as sinon.SinonStub).called).to.be.false
		})

		it("allows an active-mode update when the inactive mode has stale Dify configuration", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._store.__apiConfig = {
				planModeApiProvider: "dify",
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-sonnet-4-20250514",
			}
			controller.stateManager._store.mode = "act"

			await updateSettingsCli(
				controller,
				UpdateSettingsRequestCli.create({ settings: { preferredLanguage: "typescript" } as any }),
			)

			expect(controller.stateManager.setGlobalStateBatch.calledWithMatch({ preferredLanguage: "typescript" })).to.be.true
			expect(controller.task.applyWorkingConfigurationUpdate.calledOnce).to.be.true
		})

		it("rejects an invalid active Dify configuration before persisting settings", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._store.__apiConfig = {
				planModeApiProvider: "anthropic",
				actModeApiProvider: "dify",
				planModeApiModelId: "claude-sonnet-4-20250514",
			}
			const activeConfiguration = controller.task.getWorkingConfiguration()
			activeConfiguration.settings.actModeApiProvider = "dify"
			activeConfiguration.apiConfiguration = {
				...controller.stateManager._store.__apiConfig,
			}
			controller.stateManager._store.mode = "act"
			activeConfiguration.settings.mode = "act"
				; (apiModule.buildApiHandler as sinon.SinonStub).callsFake((configuration: any, mode: string) => {
					const provider = mode === "act" ? configuration.actModeApiProvider : configuration.planModeApiProvider
					if (provider === "dify" && (!configuration.difyApiKey || !configuration.difyBaseUrl)) {
						throw new Error("Dify requires both an API key and base URL")
					}
					return {}
				})

			try {
				await updateSettingsCli(
					controller,
					UpdateSettingsRequestCli.create({ settings: { preferredLanguage: "typescript" } as any }),
				)
				expect.fail("Should have thrown")
			} catch (error: any) {
				expect(error.message).to.equal("Dify requires both an API key and base URL")
			}

			expect(controller.stateManager.setGlobalStateBatch.called).to.be.false
			expect(controller.task.applyWorkingConfigurationUpdate.calledOnce).to.be.true
		})

		it("should update secrets batch filtering out undefined values", async () => {
			const controller = createMockController()
			const request = UpdateSettingsRequestCli.create({
				secrets: { apiKey: "secret123", openRouterApiKey: undefined } as any,
			})
			await updateSettingsCli(controller, request)
			expect(controller.stateManager.setSecretsBatch.calledOnce).to.be.true
			const batch = controller.stateManager.setSecretsBatch.firstCall.args[0]
			expect(batch.apiKey).to.equal("secret123")
			expect(batch.openRouterApiKey).to.be.undefined
		})

		it("rolls back addressed settings when the settings batch throws after mutation", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._store.preferredLanguage = "old-language"
			const originalRevision = controller.task.getWorkingConfiguration().revision
			controller.stateManager.setGlobalStateBatch = sinon.stub()
			controller.stateManager.setGlobalStateBatch.onFirstCall().callsFake((batch: any) => {
				Object.assign(controller.stateManager._store, batch)
				throw new Error("settings write failed")
			})
			controller.stateManager.setGlobalStateBatch.onSecondCall().callsFake((batch: any) => {
				Object.assign(controller.stateManager._store, batch)
			})

			try {
				await updateSettingsCli(
					controller,
					UpdateSettingsRequestCli.create({ settings: { preferredLanguage: "new-language" } as any }),
				)
				expect.fail("Should have thrown")
			} catch (error: any) {
				expect(error.message).to.equal("settings write failed")
			}

			expect(controller.stateManager._store.preferredLanguage).to.equal("old-language")
			expect(controller.task.getWorkingConfiguration().revision).to.equal(originalRevision)
			expect(controller.postStateToWebview.called).to.be.false
		})

		it("rolls back settings and secrets when the secret batch throws after mutation", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._store.preferredLanguage = "old-language"
			controller.stateManager._store.apiKey = "old-secret"
			const originalRevision = controller.task.getWorkingConfiguration().revision
			controller.stateManager.setSecretsBatch = sinon.stub()
			controller.stateManager.setSecretsBatch.onFirstCall().callsFake((batch: any) => {
				Object.assign(controller.stateManager._store, batch)
				throw new Error("secret write failed")
			})
			controller.stateManager.setSecretsBatch.onSecondCall().callsFake((batch: any) => {
				Object.assign(controller.stateManager._store, batch)
			})

			try {
				await updateSettingsCli(
					controller,
					UpdateSettingsRequestCli.create({
						settings: { preferredLanguage: "new-language" } as any,
						secrets: { apiKey: "new-secret" } as any,
					}),
				)
				expect.fail("Should have thrown")
			} catch (error: any) {
				expect(error.message).to.equal("secret write failed")
			}

			expect(controller.stateManager._store.preferredLanguage).to.equal("old-language")
			expect(controller.stateManager._store.apiKey).to.equal("old-secret")
			expect(controller.task.getWorkingConfiguration().revision).to.equal(originalRevision)
			expect(controller.postStateToWebview.called).to.be.false
		})

		it("restores an owned session mode when the session write fails", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._store.mode = "plan"
			controller.stateManager._store.__override_mode = "plan"
			const originalRevision = controller.task.getWorkingConfiguration().revision
			controller.stateManager.setSessionOverride = sinon.stub()
			controller.stateManager.setSessionOverride.onFirstCall().callsFake((key: string, value: any) => {
				controller.stateManager._store[`__override_${key}`] = value
				throw new Error("session write failed")
			})
			controller.stateManager.setSessionOverride.onSecondCall().callsFake((key: string, value: any) => {
				controller.stateManager._store[`__override_${key}`] = value
			})

			try {
				await updateSettingsCli(
					controller,
					UpdateSettingsRequestCli.create({ settings: { mode: PlanActMode.ACT } as any }),
				)
				expect.fail("Should have thrown")
			} catch (error: any) {
				expect(error.message).to.equal("session write failed")
			}

			expect(controller.stateManager._store.mode).to.equal("plan")
			expect(controller.stateManager._store.__override_mode).to.equal("plan")
			expect(controller.task.getWorkingConfiguration().revision).to.equal(originalRevision)
			expect(controller.postStateToWebview.called).to.be.false
		})

		it("should throw when terminal manager missing from active task on profile update", async () => {
			const controller = createMockController({ task: { terminalManager: undefined } })
			const request = UpdateSettingsRequestCli.create({
				settings: { defaultTerminalProfile: "profile-1" } as any,
			})
			try {
				await updateSettingsCli(controller, request)
				expect.fail("Should have thrown")
			} catch (e: any) {
				expect(e.message).to.include("Terminal manager missing")
			}
		})

		it("should return Empty response on success", async () => {
			const controller = createMockController()
			const result = await updateSettingsCli(controller, UpdateSettingsRequestCli.create({}))
			expect(result).to.deep.equal(Empty.create())
		})
	})

	describe("updateTaskSettings", () => {
		it("rolls back task-cache ownership when a batch throws after mutation", async () => {
			const controller = createMockController({ task: {} })
			controller.stateManager._taskStore["test-task-id"] = { preferredLanguage: "old" }
			const originalRevision = controller.task.getWorkingConfiguration().revision
			controller.stateManager.setTaskSettingsBatch = sinon.stub()
			controller.stateManager.setTaskSettingsBatch.onFirstCall().callsFake((taskId: string, batch: any) => {
				Object.assign(controller.stateManager._taskStore[taskId], batch)
				throw new Error("task settings write failed")
			})
			controller.stateManager.setTaskSettingsBatch.onSecondCall().callsFake((taskId: string, batch: any) => {
				Object.assign(controller.stateManager._taskStore[taskId], batch)
			})

			await updateTaskSettings(
				controller,
				UpdateTaskSettingsRequest.create({ settings: { preferredLanguage: "new", hooksEnabled: false } as any }),
			).should.be.rejectedWith("task settings write failed")

			expect(controller.stateManager._taskStore["test-task-id"]).to.deep.equal({ preferredLanguage: "old" })
			expect(controller.task.getWorkingConfiguration().revision).to.equal(originalRevision)
			expect(controller.postStateToWebview.called).to.be.false
		})

		it("should throw when no taskId provided and no active task", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({})
			try {
				await updateTaskSettings(controller, request)
				expect.fail("Should have thrown")
			} catch (e: any) {
				expect(e.message).to.include("No active task")
			}
		})

		it("should use active task taskId when no taskId in request", async () => {
			const controller = createMockController({ task: {} })
			const request = UpdateTaskSettingsRequest.create({ settings: { preferredLanguage: "python" } as any })
			await updateTaskSettings(controller, request)
			expect(controller.stateManager.setTaskSettingsBatch.calledWith("test-task-id", sinon.match.any)).to.be.true
		})

		it("should use request taskId when provided", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({
				taskId: "custom-task",
				settings: { preferredLanguage: "python" } as any,
			})
			await updateTaskSettings(controller, request)
			expect(controller.stateManager.setTaskSettingsBatch.calledWith("custom-task", sinon.match.any)).to.be.true
		})

		it("should batch update simple task settings excluding openaiReasoningEffort", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: { preferredLanguage: "go", openAiBaseUrl: "http://x" } as any,
			})
			await updateTaskSettings(controller, request)
			const batch = controller.stateManager.setTaskSettingsBatch.firstCall.args[1]
			expect(batch.preferredLanguage).to.equal("go")
			expect(batch.openAiBaseUrl).to.equal("http://x")
			expect(batch.openaiReasoningEffort).to.be.undefined
		})

		it("does not persist global Utility model settings as task overrides", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					preferredLanguage: "go",
					utilityModelEnabled: false,
					utilityModelSelection: {
						provider: ApiProvider.OPENAI,
						modelId: "gpt-5-mini",
					},
				} as any,
			})

			await updateTaskSettings(controller, request)

			const batch = controller.stateManager.setTaskSettingsBatch.firstCall.args[1]
			expect(batch.preferredLanguage).to.equal("go")
			expect(batch.utilityModelEnabled).to.be.undefined
			expect(batch.utilityModelSelection).to.be.undefined
		})

		it("should convert mode and set task setting", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: { mode: PlanActMode.PLAN } as any,
			})
			await updateTaskSettings(controller, request)
			expect(controller.stateManager.setTaskSettingsBatch.calledWith("task-1", sinon.match({ mode: "plan" }))).to.be.true
		})

		it("should set customPrompt to 'compact' only when value is 'compact'", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: { customPrompt: "compact" } as any,
			})
			await updateTaskSettings(controller, request)
			expect(controller.stateManager.setTaskSettingsBatch.calledWith("task-1", sinon.match({ customPrompt: "compact" }))).to
				.be.true
		})

		it("should not set customPrompt when value is not 'compact'", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: { customPrompt: "other" } as any,
			})
			await updateTaskSettings(controller, request)
			const batch = controller.stateManager.setTaskSettingsBatch.firstCall.args[1]
			expect(batch.customPrompt).to.be.undefined
		})

		it("should convert planModeApiProvider for task settings", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: { planModeApiProvider: ApiProvider.ANTHROPIC } as any,
			})
			await updateTaskSettings(controller, request)
			expect((conversionModule.convertProtoToApiProvider as sinon.SinonStub).calledOnce).to.be.true
			expect(
				controller.stateManager.setTaskSettingsBatch.calledWith(
					"task-1",
					sinon.match({ planModeApiProvider: "anthropic" }),
				),
			).to.be.true
		})

		it("should merge browser settings for task preserving unspecified fields", async () => {
			const controller = createMockController()
			controller.stateManager._store["browserSettings"] = { ...DEFAULT_BROWSER_SETTINGS }
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: {
					browserSettings: { viewport: { width: 500, height: 500 }, remoteBrowserEnabled: true } as any,
				} as any,
			})
			await updateTaskSettings(controller, request)
			const browserSettings = controller.stateManager.setTaskSettingsBatch.firstCall.args[1].browserSettings
			expect(browserSettings.viewport.width).to.equal(500)
			expect(browserSettings.remoteBrowserEnabled).to.equal(true)
			expect(browserSettings.disableToolUse).to.equal(DEFAULT_BROWSER_SETTINGS.disableToolUse)
		})

		it("should merge autoApprovalSettings for task settings", async () => {
			const controller = createMockController()
			controller.stateManager._store["autoApprovalSettings"] = {
				version: 1,
				actions: { readFiles: true },
				enableNotifications: false,
			}
			const request = UpdateTaskSettingsRequest.create({
				taskId: "task-1",
				settings: { autoApprovalSettings: { version: 3, actions: { editFiles: true } } as any } as any,
			})
			await updateTaskSettings(controller, request)
			const autoApprovalSettings = controller.stateManager.setTaskSettingsBatch.firstCall.args[1].autoApprovalSettings
			expect(autoApprovalSettings.version).to.equal(3)
			expect(autoApprovalSettings.actions.readFiles).to.equal(true)
			expect(autoApprovalSettings.actions.editFiles).to.equal(true)
		})

		it("should handle request with no settings gracefully", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({ taskId: "task-1" })
			const result = await updateTaskSettings(controller, request)
			expect(result).to.deep.equal(Empty.create())
			expect(controller.postStateToWebview.calledOnce).to.be.true
		})

		it("should return Empty response on success", async () => {
			const controller = createMockController()
			const request = UpdateTaskSettingsRequest.create({ taskId: "task-1", settings: { preferredLanguage: "rust" } as any })
			const result = await updateTaskSettings(controller, request)
			expect(result).to.deep.equal(Empty.create())
		})
	})
})
