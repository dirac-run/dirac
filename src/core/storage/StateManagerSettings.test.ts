import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { GLOBAL_STATE_DEFAULTS, isSettingsKey, SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { buildEffectiveSettingsFromCache, type StateManagerSettingsCaches } from "./StateManagerSettings"

describe("retired completion-check setting", () => {
	for (const legacyValue of [undefined, false, true]) {
		it(`excludes saved value ${legacyValue} from effective settings`, () => {
			const saved = {
				...SETTINGS_DEFAULTS,
				...(legacyValue === undefined ? {} : { doubleCheckCompletionEnabled: legacyValue }),
			}
			const caches = {
				globalStateCache: saved,
				taskStateCache: saved,
				sessionOverrideCache: {},
				secretsCache: {},
			} as StateManagerSettingsCaches

			const settings = buildEffectiveSettingsFromCache(caches, saved as Partial<Settings>)

			assert.equal(isSettingsKey("doubleCheckCompletionEnabled"), false)
			assert.equal(Object.hasOwn(SETTINGS_DEFAULTS, "doubleCheckCompletionEnabled"), false)
			assert.equal(Object.hasOwn(settings, "doubleCheckCompletionEnabled"), false)
		})
	}
})

describe("global role settings resolution", () => {
	it("ignores task, session and explicit role catalogs without changing released precedence", () => {
		const roles = [{ name: "Global reviewer", description: "Review code.", enabled: false }]
		const caches = {
			globalStateCache: { ...GLOBAL_STATE_DEFAULTS, ...SETTINGS_DEFAULTS, subagentRoles: roles, preferredLanguage: "global" },
			taskStateCache: { subagentRoles: [], preferredLanguage: "task" },
			sessionOverrideCache: { subagentRoles: [], preferredLanguage: "session" },
			secretsCache: {},
		} as unknown as StateManagerSettingsCaches
		const settings = buildEffectiveSettingsFromCache(caches, { subagentRoles: [], preferredLanguage: "explicit" })
		assert.deepEqual(settings.subagentRoles, roles)
		assert.equal(settings.preferredLanguage, "explicit")
		assert.equal(buildEffectiveSettingsFromCache(caches).preferredLanguage, "session")
	})
})
