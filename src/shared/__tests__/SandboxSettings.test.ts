import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { DEFAULT_SANDBOX_SETTINGS as defaults, SANDBOX_PROFILES, validateSandboxSettings } from "../SandboxSettings"
import { Settings, UpdateSettingsRequest } from "../proto/dirac/state"

describe("Sandbox settings", () => {
	it("starts disabled with explicit fallback off and immutable built-in choices", () => {
		assert.deepEqual(defaults, { enabled: false, allowUnsandboxedFallback: false, mainAgentProfileId: "default", subagentProfileId: "default", profiles: [] })
		assert.deepEqual(SANDBOX_PROFILES.map((profile) => profile.id), ["default", "builtin-workspace", "builtin-offline-workspace", "builtin-read-only"])
		assert.deepEqual(validateSandboxSettings(defaults), defaults)
	})
	it("rejects malformed settings without coercion or guessed profiles", () => {
		for (const value of [null, [], {}, { ...defaults, enabled: "false" }, { ...defaults, allowUnsandboxedFallback: 1 },
			{ ...defaults, mainAgentProfileId: "unknown" }, { ...defaults, subagentProfileId: "unknown" }, { ...defaults, unknown: [] }]) {
			assert.throws(() => validateSandboxSettings(value))
		}
	})
	it("round-trips explicit false and distinguishes omitted fields from false", () => {
		const decoded = Settings.decode(Settings.encode(Settings.create({ sandboxSettings: defaults })).finish())
		assert.deepEqual(validateSandboxSettings(decoded.sandboxSettings), defaults)
		const enabled = { ...defaults, enabled: true, allowUnsandboxedFallback: true }
		const request = UpdateSettingsRequest.decode(UpdateSettingsRequest.encode(UpdateSettingsRequest.create({ sandboxSettings: enabled })).finish())
		assert.deepEqual(validateSandboxSettings(request.sandboxSettings), enabled)
		assert.equal(UpdateSettingsRequest.decode(new Uint8Array()).sandboxSettings, undefined)
		const incomplete = UpdateSettingsRequest.decode(UpdateSettingsRequest.encode(UpdateSettingsRequest.create({ sandboxSettings: {} })).finish())
		assert.throws(() => validateSandboxSettings(incomplete.sandboxSettings))
	})
})
