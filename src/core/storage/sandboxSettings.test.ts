import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { DEFAULT_SANDBOX_SETTINGS as defaults, validateSandboxSettings } from "@shared/SandboxSettings"
import { GLOBAL_STATE_DEFAULTS, SETTINGS_DEFAULTS } from "@shared/storage/state-keys"
import { buildEffectiveSettingsFromCache, normalizeLoadedSettings, type StateManagerSettingsCaches } from "./StateManagerSettings"
import * as setters from "./StateManagerSetters"

describe("trusted global Sandbox settings", () => {
	it("keeps fresh CLI and extension host settings off with no authorized fallback", () => {
		const caches = {
			globalStateCache: { ...GLOBAL_STATE_DEFAULTS, ...SETTINGS_DEFAULTS },
			taskStateCache: {}, sessionOverrideCache: {}, secretsCache: {},
		} as StateManagerSettingsCaches
		const fresh = buildEffectiveSettingsFromCache(caches).sandboxSettings
		assert.equal(fresh.enabled, false)
		assert.equal(fresh.allowUnsandboxedFallback, false)
		assert.equal(fresh.mainAgentProfileId, "default")
		assert.equal(fresh.subagentProfileId, "default")
	})
	it("ignores task, session and explicit runtime overrides", () => {
		const override = { ...defaults, enabled: true, allowUnsandboxedFallback: true }
		const caches = {
			globalStateCache: { ...GLOBAL_STATE_DEFAULTS, ...SETTINGS_DEFAULTS },
			taskStateCache: { sandboxSettings: override }, sessionOverrideCache: { sandboxSettings: override }, secretsCache: {},
		} as StateManagerSettingsCaches
		assert.deepEqual(buildEffectiveSettingsFromCache(caches, { sandboxSettings: override }).sandboxSettings, defaults)
	})
	it("keeps invalid saved configuration without taking down settings initialization", () => {
		const saved = { sandboxSettings: { enabled: "broken" } } as never
		assert.deepEqual(normalizeLoadedSettings(saved), saved)
		assert.throws(() => validateSandboxSettings(normalizeLoadedSettings(saved).sandboxSettings))
	})
	it("rejects non-global writes before persistence or cache mutation", () => {
		const ctx = { isInitialized: true } as setters.StateManagerSettersContext
		for (const write of [
			() => setters.setTaskSettings(ctx, "task", "sandboxSettings", defaults),
			() => setters.setTaskSettingsBatch(ctx, "task", { sandboxSettings: defaults }),
			() => setters.setSessionOverride(ctx, "sandboxSettings", defaults),
			() => setters.setWorkspaceState(ctx, "sandboxSettings", defaults),
			() => setters.setWorkspaceStateBatch(ctx, { sandboxSettings: defaults } as never),
		]) assert.throws(write, /user-global/)
	})
	it("discards sandbox configuration in loaded task files", async () => {
		const ctx = {
			isInitialized: true, taskStateCache: {}, persistence: {
				loadTaskSettingsFromDisk: async () => ({ sandboxSettings: { ...defaults, enabled: true } }),
			}
		} as unknown as setters.StateManagerSettersContext
		await setters.loadTaskSettings(ctx, "task")
		assert.equal(Object.hasOwn(ctx.taskStateCache, "sandboxSettings"), false)
	})
})
