/**
 * Characterization tests for StateManager.
 * Captures current behavior — bugs and all.
 *
 * Phase 0 — Prerequisite coverage for refactoring
 */
import { afterEach, beforeEach, describe, it } from "mocha"
import { expect } from "chai"
import "should"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import type { DiracFileStorage } from "@/shared/storage/DiracFileStorage"
import type { DiracMemento } from "@/shared/storage/DiracStorage"
import type { StorageContext } from "@/shared/storage/storage-context"
import { StateManager } from "../StateManager"
import { TEST_MODEL_IDS } from "@test/fixtures/model-ids"
import { expectLoggerErrors } from "@test/loggerGuard"

import {
	buildEffectiveApiConfigurationFromCache,
	buildEffectiveSettingsFromCache,
	type StateManagerSettingsCaches,
} from "../StateManagerSettings"
import { ApiHandlerSettingsKeys, SettingsKeys, type GlobalStateAndSettings, type Secrets, type Settings } from "@shared/storage/state-keys"
describe("StateManager", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let storage: StorageContext

	function createMockMemento(initial: Record<string, any> = {}): DiracMemento {
		const data = { ...initial }
		return {
			get: (key: string, defaultValue?: any) => data[key] ?? defaultValue,
			update: async (key: string, value: any) => {
				data[key] = value
			},
			keys: () => Object.keys(data),
			setBatch: async (entries: Record<string, any>) => {
				Object.assign(data, entries)
			},
		}
	}

	function createMockFileStorage(initial: Record<string, any> = {}): DiracFileStorage {
		const data = { ...initial }
		return {
			get: (key: string) => data[key],
			set: (key: string, value: any) => {
				data[key] = value
			},
			setBatch: (entries: Record<string, any>) => Object.assign(data, entries),
			delete: (key: string) => {
				delete data[key]
			},
			keys: () => Object.keys(data),
			entries: () => Object.entries(data),
		} as unknown as DiracFileStorage
	}

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		sandbox.stub(HostProvider, "get").returns({
			globalStorageFsPath: tempDir,
			hostBridge: { workspaceClient: {}, envClient: { getHostVersion: sandbox.stub().resolves({}) } },
		} as any)
		tempDir = path.join(os.tmpdir(), `dirac-sm-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })

		storage = {
			globalState: createMockMemento({ mode: "plan", taskHistory: [] }),
			globalStateBackingStore: createMockFileStorage({ mode: "plan", taskHistory: [], addedApiProviders: [] }),
			secrets: createMockFileStorage({}),
			workspaceState: createMockFileStorage({}),
			dataDir: tempDir,
			diracDir: tempDir,
			workspaceStoragePath: tempDir,
		}

		if ((StateManager as any).instance?.persistence) {
			await (StateManager as any).instance.persistence.dispose()
		}
		// Reset singleton
		; (StateManager as any).instance = undefined
	})

	afterEach(async () => {
		// Cancel any pending debounced persistence timers before teardown
		if ((StateManager as any).instance?.persistence) {
			await (StateManager as any).instance.persistence.dispose()
		}
		sandbox.restore()
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch { }
		; (StateManager as any).instance = undefined
	})

	// ---------------------------------------------------------------
	describe("initialize and get", () => {
		it("initialize returns a StateManager", async function () {
			this.skip()
		}) // env issue
		it.skip("initialize returns a StateManager", async () => {
			const sm = await StateManager.initialize(storage)
			sm.should.be.instanceOf(StateManager)
		})

		it("get returns same instance after initialize", async () => {
			const sm = await StateManager.initialize(storage)
			StateManager.get().should.equal(sm)
		})

		it("get throws before initialize", () => {
			; (() => StateManager.get()).should.throw()
		})

		it("initialize twice throws", async () => {
			await StateManager.initialize(storage)
			await StateManager.initialize(storage).should.be.rejected()
		})
	})

	// ---------------------------------------------------------------
	describe("legacy keyless provider membership migration", () => {
		it("persists legacy membership before selections change and does not migrate again", async () => {
			storage.globalStateBackingStore.delete("addedApiProviders")
			await storage.globalState.update("planModeApiProvider", "claude-code")
			await storage.globalState.update("actModeApiProvider", "lmstudio")
			const sm = await StateManager.initialize(storage)
			expect(storage.globalStateBackingStore.get("addedApiProviders")).to.deep.equal(["claude-code", "lmstudio"])
			expect(sm.getSystemDefaultSettingsKey("addedApiProviders")).to.deep.equal(["claude-code", "lmstudio"])
			sm.setApiConfiguration({ planModeApiProvider: "anthropic", actModeApiProvider: "anthropic" })
			await sm.flushPendingState()
			// The production Memento reads the backing store; reconnect the test doubles for restart.
			storage.globalState.get = storage.globalStateBackingStore.get.bind(storage.globalStateBackingStore)
			const write = sandbox.spy(storage.globalStateBackingStore, "setBatch")
			await sm.reInitialize()
			expect(StateManager.get().getSystemDefaultSettingsKey("addedApiProviders")).to.deep.equal(["claude-code", "lmstudio"])
			sinon.assert.notCalled(write)
		})

		it("marks fresh storage migrated without turning selection defaults into providers", async () => {
			storage.globalStateBackingStore.delete("addedApiProviders")
			await StateManager.initialize(storage)
			expect(storage.globalStateBackingStore.get("addedApiProviders")).to.deep.equal([])
		})

		it("preserves explicitly stored membership", async () => {
			await storage.globalState.update("planModeApiProvider", "claude-code")
			const write = sandbox.spy(storage.globalStateBackingStore, "setBatch")
			const sm = await StateManager.initialize(storage)
			expect(sm.getSystemDefaultSettingsKey("addedApiProviders")).to.deep.equal([])
			sinon.assert.notCalled(write)
		})

		it("does not publish initialized state if durable migration fails", async () => {
			expectLoggerErrors()
			storage.globalStateBackingStore.delete("addedApiProviders")
			sandbox.stub(storage.globalStateBackingStore, "setBatch").throws(new Error("membership write failed"))
			await StateManager.initialize(storage).should.be.rejectedWith("membership write failed")
			expect(StateManager.isInitialized()).to.equal(false)
		})
	})

	describe("utility model migration", () => {
		async function setPersistedUtilitySetting(key: string, value: boolean): Promise<void> {
			await storage.globalState.update(key, value)
			storage.globalStateBackingStore.set(key, value)
		}

		it("keeps fresh installs on the independent use-case defaults", async () => {
			const setBatch = sandbox.spy(storage.globalStateBackingStore, "setBatch")

			const sm = await StateManager.initialize(storage)

			sm.getGlobalSettingsKey("utilityModelUseCondense").should.equal(true)
			sm.getGlobalSettingsKey("utilityModelUseGenerateCommitMessage").should.equal(true)
			sinon.assert.notCalled(setBatch)
		})

		it("migrates a legacy enabled setting to every missing use case", async () => {
			await setPersistedUtilitySetting("utilityModelEnabled", true)

			const sm = await StateManager.initialize(storage)

			sm.getGlobalSettingsKey("utilityModelUseCondense").should.equal(true)
			sm.getGlobalSettingsKey("utilityModelUseGenerateCommitMessage").should.equal(true)
		})

		it("preserves a legacy opt-out for every missing use case", async () => {
			await setPersistedUtilitySetting("utilityModelEnabled", false)

			const sm = await StateManager.initialize(storage)

			sm.getGlobalSettingsKey("utilityModelUseCondense").should.equal(false)
			sm.getGlobalSettingsKey("utilityModelUseGenerateCommitMessage").should.equal(false)
		})

		it("preserves explicit use cases while backfilling only missing settings", async () => {
			await setPersistedUtilitySetting("utilityModelEnabled", true)
			await setPersistedUtilitySetting("utilityModelUseCondense", false)

			const sm = await StateManager.initialize(storage)

			sm.getGlobalSettingsKey("utilityModelUseCondense").should.equal(false)
			sm.getGlobalSettingsKey("utilityModelUseGenerateCommitMessage").should.equal(true)
		})

		it("does not rewrite configurations with every independent use case persisted", async () => {
			await setPersistedUtilitySetting("utilityModelEnabled", false)
			await setPersistedUtilitySetting("utilityModelUseCondense", true)
			await setPersistedUtilitySetting("utilityModelUseGenerateCommitMessage", true)
			const setBatch = sandbox.spy(storage.globalStateBackingStore, "setBatch")

			const sm = await StateManager.initialize(storage)

			sm.getGlobalSettingsKey("utilityModelUseCondense").should.equal(true)
			sm.getGlobalSettingsKey("utilityModelUseGenerateCommitMessage").should.equal(true)
			sinon.assert.notCalled(setBatch)
		})
	})

	// ---------------------------------------------------------------
	describe("global state", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("setGlobalState stores value", () => {
			sm.setGlobalState("mode", "act")
			sm.getGlobalSettingsKey("mode").should.equal("act")
		})

		it("setGlobalStateBatch stores multiple values", () => {
			sm.setGlobalStateBatch({ mode: "act", preferredLanguage: "fr" })
			sm.getGlobalSettingsKey("mode").should.equal("act")
			sm.getGlobalSettingsKey("preferredLanguage").should.equal("fr")
		})

		it("getGlobalStateKey returns global state value", () => {
			sm.getGlobalStateKey("taskHistory").should.be.an.Array()
		})

		it("getGlobalSettingsKey returns undefined for unknown key", () => {
			const v = sm.getGlobalSettingsKey("nonexistent" as any)
				; (v === undefined).should.be.true()
		})
	})

	// ---------------------------------------------------------------
	describe("task settings", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("setTaskSettings stores task-specific value", () => {
			sm.setTaskSettings("task1", "mode", "plan")
			sm.getGlobalSettingsKey("mode").should.equal("plan")
		})

		it("setTaskSettingsBatch stores multiple values", () => {
			sm.setTaskSettingsBatch("task1", { mode: "act", customPrompt: "compact" })
			sm.getGlobalSettingsKey("mode").should.equal("act")
		})

		it("clearTaskSettings clears task cache", async () => {
			sm.setGlobalState("mode", "plan")
			sm.setTaskSettings("task1", "mode", "act")
			sm.getGlobalSettingsKey("mode").should.equal("act")
			await sm.clearTaskSettings()
			const v = sm.getGlobalSettingsKey("mode")
			v.should.equal("plan")
		})
	})

	// ---------------------------------------------------------------
	describe("secrets", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("setSecret stores secret value", () => {
			sm.setSecret("apiKey", "sk-test123")
			sm.getSecretKey("apiKey")!.should.equal("sk-test123")
		})

		it("setSecretsBatch stores multiple secrets", () => {
			sm.setSecretsBatch({ apiKey: "key1", openRouterApiKey: "key2" })
			sm.getSecretKey("apiKey")!.should.equal("key1")
			sm.getSecretKey("openRouterApiKey")!.should.equal("key2")
		})

		it("getSecretKey returns undefined for unknown key", () => {
			const v = sm.getSecretKey("nonexistent" as any)
				; (v === undefined).should.be.true()
		})
	})

	// ---------------------------------------------------------------
	describe("workspace state", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("setWorkspaceState stores value", () => {
			sm.setWorkspaceState("localDiracRulesToggles", { rule1: true })
			sm.getWorkspaceStateKey("localDiracRulesToggles").should.deepEqual({ rule1: true })
		})

		it("setWorkspaceStateBatch stores multiple values", () => {
			sm.setWorkspaceStateBatch({ localDiracRulesToggles: { a: true }, workflowToggles: { b: false } })
			sm.getWorkspaceStateKey("localDiracRulesToggles").should.deepEqual({ a: true })
		})
	})

	// ---------------------------------------------------------------
	describe("session override", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("session override takes precedence over global", () => {
			sm.setGlobalState("mode", "plan")
			sm.setSessionOverride("mode", "act")
			sm.getGlobalSettingsKey("mode").should.equal("act")
		})

		it("an owned undefined session value blocks task and global runtime inheritance", () => {
			sm.setGlobalState("actModeApiModelId", "global-model")
			sm.setTaskSettings("task1", "actModeApiModelId", "task-model")
			sm.setSessionOverride("actModeApiModelId", undefined)

			const value = sm.getGlobalSettingsKey("actModeApiModelId")
				; (value === undefined).should.be.true()
		})

		it("system-default reads ignore task and session runtime state", () => {
			sm.setGlobalState("actModeApiModelId", "global-model")
			sm.setTaskSettings("task1", "actModeApiModelId", "task-model")
			sm.setSessionOverride("actModeApiModelId", "session-model")

			sm.getSystemDefaultSettingsKey("actModeApiModelId")!.should.equal("global-model")
		})

		it("reports and clears session override ownership", () => {
			sm.hasSessionOverride("mode").should.equal(false)
			sm.setSessionOverride("mode", "act")
			sm.hasSessionOverride("mode").should.equal(true)
			sm.clearSessionOverride("mode")
			sm.hasSessionOverride("mode").should.equal(false)
		})
	})

	// ---------------------------------------------------------------
	describe("API configuration", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("getApiConfiguration returns object", () => {
			const config = sm.getApiConfiguration()
			config.should.be.an.Object()
		})

		it("setApiConfiguration does not throw", () => {
			; (() => sm.setApiConfiguration({ apiProvider: "anthropic" } as any)).should.not.throw()
		})
	})

	// ---------------------------------------------------------------
	describe("task working configuration capture", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("captures effective precedence without installing explicit runtime overrides", () => {
			sm.setGlobalState("mode", "act")
			sm.setTaskSettings("task1", "mode", "plan")
			sm.setSessionOverride("preferredLanguage", "French")

			const captured = sm.captureEffectiveTaskConfiguration({ mode: "act", actModeApiModelId: undefined })

			captured.settings.mode.should.equal("act")
			captured.settings.preferredLanguage.should.equal("French")
			Object.hasOwn(captured.settings, "actModeApiModelId").should.equal(true)
				; (captured.settings.actModeApiModelId === undefined).should.equal(true)
			// Pure explicit resolution must not change the live cache.
			sm.getGlobalSettingsKey("mode").should.equal("plan")
		})

		it("deeply detaches settings, workspace configuration, and credentials", () => {
			const browserSettings = { viewport: { width: 1200, height: 800 }, customArgs: "--test" }
			const localSkillsToggles = { skill: true }
			sm.setGlobalState("browserSettings", browserSettings)
			sm.setWorkspaceState("localSkillsToggles", localSkillsToggles)
			sm.setSecret("apiKey", "captured-secret")

			const captured = sm.captureEffectiveTaskConfiguration()
			browserSettings.viewport.width = 1
			localSkillsToggles.skill = false
			sm.setSecret("apiKey", "new-secret")

			captured.settings.browserSettings.viewport.width.should.equal(1200)
			captured.workspaceConfiguration.localSkillsToggles.skill.should.equal(true)
			captured.apiConfiguration.apiKey!.should.equal("captured-secret")
			Object.isFrozen(captured.settings.browserSettings.viewport).should.equal(true)
		})

		it("captures explicit execution options independently of later global writes", () => {
			const captured = sm.captureEffectiveTaskConfiguration(undefined, {
				terminalReuseEnabled: false,
				vscodeTerminalExecutionMode: "backgroundExec",
				multiRootEnabled: false,
			})
			sm.setGlobalState("terminalReuseEnabled", true)
			sm.setGlobalState("multiRootEnabled", true)

			captured.executionOptions.should.deepEqual({
				terminalReuseEnabled: false,
				vscodeTerminalExecutionMode: "backgroundExec",
				multiRootEnabled: false,
			})
		})

		it("matches the live effective getters across a precedence matrix", () => {
			const scenarios: Array<{
				global?: Partial<Settings>
				task?: Partial<Settings>
				session?: Partial<Settings>
				explicit?: Partial<Settings>
			}> = [
					{ global: { mode: "act", preferredLanguage: "Global" } },
					{ global: { mode: "act" }, task: { mode: "plan", preferredLanguage: "Task" } },
					{ global: { mode: "act" }, task: { mode: "plan" }, session: { mode: "act" } },
					{
						global: { actModeApiModelId: "global-model" },
						task: { actModeApiModelId: "task-model" },
						session: { actModeApiModelId: undefined },
					},
					{
						global: { mode: "plan", preferredLanguage: "Global" },
						task: { mode: "act", preferredLanguage: "Task" },
						session: { preferredLanguage: "Session" },
						explicit: { mode: "plan", preferredLanguage: undefined },
					},
				]

			for (const scenario of scenarios) {
				if (scenario.global) sm.setGlobalStateBatch(scenario.global)
				if (scenario.task) sm.setTaskSettingsBatch("task1", scenario.task)
				for (const [key, value] of Object.entries(scenario.session ?? {})) {
					sm.setSessionOverride(key as keyof Settings, value as never)
				}

				const captured = sm.captureEffectiveTaskConfiguration(scenario.explicit)
				for (const key of SettingsKeys) {
					const expected = scenario.explicit && Object.hasOwn(scenario.explicit, key)
						? scenario.explicit[key]
						: sm.getGlobalSettingsKey(key)
					expect(captured.settings[key]).to.deep.equal(expected)
				}
			}
		})

		it("pure builders match capture and API getters without mutating caches", () => {
			sm.setGlobalStateBatch({
				mode: "act",
				actModeApiProvider: "openai",
				actModeOpenAiModelId: "global-model:1m",
				preferredLanguage: "Global",
			})
			sm.setTaskSettingsBatch("task1", {
				actModeOpenAiModelId: "task-model:1m",
				preferredLanguage: "Task",
			})
			sm.setSessionOverride("preferredLanguage", "Session")
			sm.setSecret("openAiApiKey", "persisted-secret")

			const internals = sm as any
			const caches: StateManagerSettingsCaches = {
				sessionOverrideCache: internals.sessionOverrideCache,
				taskStateCache: internals.taskStateCache,
				globalStateCache: internals.globalStateCache as GlobalStateAndSettings,
				secretsCache: internals.secretsCache as Secrets,
			}
			const explicit: Partial<Settings> = { mode: "plan", preferredLanguage: undefined }
			const settings = buildEffectiveSettingsFromCache(caches, explicit)
			const api = buildEffectiveApiConfigurationFromCache(caches, explicit)
			const captured = sm.captureEffectiveTaskConfiguration(explicit)

			settings.should.deepEqual(captured.settings)
			api.should.deepEqual(captured.apiConfiguration)
			buildEffectiveSettingsFromCache(caches).should.deepEqual(
				Object.fromEntries(SettingsKeys.map((key) => [key, sm.getGlobalSettingsKey(key)])),
			)
			buildEffectiveApiConfigurationFromCache(caches).should.deepEqual(sm.getApiConfiguration())
			sm.captureEffectiveTaskConfiguration().apiConfiguration.should.deepEqual(sm.getApiConfiguration())
			for (const key of ApiHandlerSettingsKeys) expect(api[key]).to.deep.equal(settings[key])
			api.openAiApiKey!.should.equal("persisted-secret")
			settings.actModeOpenAiModelId!.should.equal("task-model")
			Object.hasOwn(settings, "preferredLanguage").should.equal(true)
				; (settings.preferredLanguage === undefined).should.equal(true)
			// Explicit resolution is pure and does not install overrides.
			sm.getGlobalSettingsKey("mode").should.equal("act")
			sm.getGlobalSettingsKey("preferredLanguage")!.should.equal("Session")
		})

		it("preserves API secret and environment precedence exactly", () => {
			const envKeys = [
				"OPENAI_API_KEY",
				"OPENAI_API_BASE",
				"DIRAC_PROVIDER",
				"DIRAC_API_KEY",
				"DIRAC_MODEL",
				"DIRAC_BASE_URL",
			] as const
			const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
			try {
				process.env.OPENAI_API_KEY = "legacy-secret"
				process.env.OPENAI_API_BASE = "https://legacy.example"
				delete process.env.DIRAC_PROVIDER
				delete process.env.DIRAC_API_KEY
				delete process.env.DIRAC_MODEL
				delete process.env.DIRAC_BASE_URL

				let captured = sm.captureEffectiveTaskConfiguration()
				captured.apiConfiguration.openAiApiKey!.should.equal("legacy-secret")
				captured.settings.openAiBaseUrl!.should.equal("https://legacy.example")

				sm.setSecret("openAiApiKey", "persisted-secret")
				sm.setGlobalState("openAiBaseUrl", "https://persisted.example")
				captured = sm.captureEffectiveTaskConfiguration()
				captured.apiConfiguration.openAiApiKey!.should.equal("persisted-secret")

				sm.setSecret("openAiApiKey", "")
				captured = sm.captureEffectiveTaskConfiguration()
				captured.apiConfiguration.openAiApiKey!.should.equal("legacy-secret")
				sm.setSecret("openAiApiKey", "persisted-secret")
				captured.settings.openAiBaseUrl!.should.equal("https://persisted.example")

				process.env.DIRAC_PROVIDER = "openai"
				process.env.DIRAC_API_KEY = "explicit-secret"
				process.env.DIRAC_MODEL = "explicit-model:1m"
				process.env.DIRAC_BASE_URL = "https://explicit.example"
				captured = sm.captureEffectiveTaskConfiguration()
				captured.apiConfiguration.openAiApiKey!.should.equal("explicit-secret")
				captured.settings.actModeApiProvider.should.equal("openai")
				captured.settings.planModeApiProvider.should.equal("openai")
				captured.settings.actModeOpenAiModelId!.should.equal("explicit-model")
				captured.settings.planModeOpenAiModelId!.should.equal("explicit-model")
				captured.settings.openAiBaseUrl!.should.equal("https://explicit.example")

				const ownedUndefined = sm.captureEffectiveTaskConfiguration({ openAiBaseUrl: undefined })
				Object.hasOwn(ownedUndefined.settings, "openAiBaseUrl").should.equal(true)
					; (ownedUndefined.settings.openAiBaseUrl === undefined).should.equal(true)
			} finally {
				for (const key of envKeys) {
					const value = previousEnv[key]
					if (value === undefined) delete process.env[key]
					else process.env[key] = value
				}
			}
		})
	})

	// ---------------------------------------------------------------
	describe("models cache", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("setModelsCache stores and getModelsCache retrieves", () => {
			const models = { [TEST_MODEL_IDS.OPENAI]: { id: TEST_MODEL_IDS.OPENAI, name: "GPT-4" } as any }
			sm.setModelsCache("openRouter", models)
			sm.getModelsCache("openRouter")!.should.deepEqual(models)
		})

		it("getModelsCache returns null for uncached provider", () => {
			; (sm.getModelsCache("dirac") === null).should.be.true() // null is valid for uncached provider
		})
	})

	// ---------------------------------------------------------------
	describe("callbacks", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("registerCallbacks accepts persistence error callback", () => {
			const cb = sandbox.stub()
			sm.registerCallbacks({ onPersistenceError: cb })
			sm.onPersistenceError!.should.equal(cb)
		})

		it("registerCallbacks accepts sync external change callback", () => {
			const cb = sandbox.stub()
			sm.registerCallbacks({ onSyncExternalChange: cb })
			sm.onSyncExternalChange!.should.equal(cb)
		})
	})

	// ---------------------------------------------------------------
	describe("flush and entries", () => {
		let sm: StateManager

		beforeEach(async () => {
			sm = await StateManager.initialize(storage)
		})

		it("flushPendingState resolves", async () => {
			await sm.flushPendingState().should.not.be.rejected()
		})

		it("getAllGlobalStateEntries returns object", () => {
			const entries = sm.getAllGlobalStateEntries()
			entries.should.be.an.Object()
		})

		it("getAllWorkspaceStateEntries returns object", () => {
			const entries = sm.getAllWorkspaceStateEntries()
			entries.should.be.an.Object()
		})
	})

	// ---------------------------------------------------------------
	describe("reInitialize", () => {
		it.skip("reinitializes state manager", async () => {
			const sm = await StateManager.initialize(storage)
			sm.setGlobalState("mode", "act")
			await sm.reInitialize()
			const v = sm.getGlobalSettingsKey("mode")
				; (v === undefined).should.be.true()
		})
	})
})
