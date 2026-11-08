import assert from "node:assert/strict"
import fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import * as envConfig from "@shared/storage/env-config"
import { GLOBAL_STATE_DEFAULTS, SETTINGS_DEFAULTS, type Secrets, type Settings } from "@shared/storage/state-keys"
import { getProviderMembershipState } from "./providerMembership"
import type { StateManager } from "./StateManager"
import { buildEffectiveSettingsFromCache, type StateManagerSettingsCaches } from "./StateManagerSettings"
import { setSessionOverride, setTaskSettings, setTaskSettingsBatch, setWorkspaceState, type StateManagerSettersContext } from "./StateManagerSetters"

describe("global provider membership publication", () => {
	beforeEach(() => {
		sinon.stub(fs, "existsSync").returns(false)
		sinon.stub(envConfig, "getSettingsFromEnv").returns({})
		sinon.stub(envConfig, "getSecretsFromEnv").returns({})
		sinon.stub(envConfig, "getExplicitDiracSettingsFromEnv").returns({})
		sinon.stub(envConfig, "getExplicitDiracSecretsFromEnv").returns({})
	})
	afterEach(() => sinon.restore())

	it("publishes global saved setup even when a task shadows the endpoint", () => {
		const settings = { ...SETTINGS_DEFAULTS, openAiBaseUrl: "https://saved.example", addedApiProviders: ["vscode-lm"] } as Settings
		const secrets: Partial<Secrets> = { "openai-codex-oauth-credentials": '{"expires_at":1}' }
		const stateManager: Pick<StateManager, "getSystemDefaultSettingsKey" | "getSecretKey"> = {
			getSystemDefaultSettingsKey: (key) => settings[key],
			getSecretKey: (key) => secrets[key],
		}
		assert.deepEqual(getProviderMembershipState(stateManager), {
			addedApiProviders: ["vscode-lm"],
			configuredApiProviders: ["openai", "openai-codex", "vscode-lm"],
		})
	})

	it("retains environment-backed access without replacing saved setup evidence", () => {
		; (envConfig.getSecretsFromEnv as sinon.SinonStub).returns({ geminiApiKey: "environment-key" })
		const settings = { ...SETTINGS_DEFAULTS, lmStudioBaseUrl: "http://localhost:1234" } as Settings
		const stateManager: Pick<StateManager, "getSystemDefaultSettingsKey" | "getSecretKey"> = {
			getSystemDefaultSettingsKey: (key) => settings[key],
			getSecretKey: () => undefined,
		}
		assert.deepEqual(getProviderMembershipState(stateManager).configuredApiProviders, ["lmstudio", "gemini"])
	})

	it("retains default-file Qwen OAuth setup after both modes switch away", () => {
		const credentialPath = path.join(os.homedir(), ".qwen", "oauth_creds.json")
		const exists = fs.existsSync as sinon.SinonStub
		exists.withArgs(credentialPath).returns(true)
		const settings = {
			...SETTINGS_DEFAULTS,
			planModeApiProvider: "qwen-code",
			actModeApiProvider: "qwen-code",
		} as Settings
		const stateManager: Pick<StateManager, "getSystemDefaultSettingsKey" | "getSecretKey"> = {
			getSystemDefaultSettingsKey: (key) => settings[key],
			getSecretKey: () => undefined,
		}
		assert.equal(settings.qwenCodeOauthPath, undefined)
		assert.deepEqual(getProviderMembershipState(stateManager).configuredApiProviders, ["qwen-code"])
		settings.planModeApiProvider = "openrouter"
		settings.actModeApiProvider = "openrouter"
		assert.deepEqual(getProviderMembershipState(stateManager).configuredApiProviders, ["qwen-code"])
		assert.deepEqual(settings.addedApiProviders, [])
		// No credentials are read or refreshed: expiry is irrelevant to membership.
		exists.withArgs(credentialPath).returns(false)
		assert.deepEqual(getProviderMembershipState(stateManager).configuredApiProviders, [])
	})

	it("ignores task, session and explicit overrides of membership metadata", () => {
		const caches = {
			globalStateCache: { ...GLOBAL_STATE_DEFAULTS, ...SETTINGS_DEFAULTS, addedApiProviders: ["vscode-lm"] },
			taskStateCache: { addedApiProviders: ["lmstudio"] },
			sessionOverrideCache: { addedApiProviders: ["claude-code"] },
			secretsCache: {},
		} as StateManagerSettingsCaches
		assert.deepEqual(buildEffectiveSettingsFromCache(caches, { addedApiProviders: [] }).addedApiProviders, ["vscode-lm"])
	})

	it("rejects non-global writes before updating caches or scheduling persistence", () => {
		const ctx = { isInitialized: true } as StateManagerSettersContext
		assert.throws(() => setTaskSettings(ctx, "task", "addedApiProviders", []), /user-global/)
		assert.throws(() => setTaskSettingsBatch(ctx, "task", { addedApiProviders: [] }), /user-global/)
		assert.throws(() => setSessionOverride(ctx, "addedApiProviders", []), /user-global/)
		assert.throws(() => setWorkspaceState(ctx, "addedApiProviders", []), /user-global/)
	})
})
