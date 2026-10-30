import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { isSettingsKey, SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
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
