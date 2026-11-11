import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { type CustomSandboxProfile, DEFAULT_SANDBOX_SETTINGS as defaults, SANDBOX_BUILTIN_PROFILE_IDS, SANDBOX_PROFILES, getSandboxProfiles, prepareSandboxSettingsUpdate, resolveSandboxProfile, validateCustomSandboxProfile, validateSandboxSettings } from "../SandboxSettings"
import { Settings } from "../proto/dirac/state"
import { sandboxProfileDraft, sandboxProfileFromDraft } from "../settings-presentation"

function preset(id: string): CustomSandboxProfile {
	const profile = resolveSandboxProfile(defaults, id)
	assert.ok("kind" in profile)
	return profile
}

describe("built-in sandbox presets", () => {
	it("keeps Default unchanged and provides full restrictive policies", () => {
		assert.deepEqual(SANDBOX_PROFILES[0], { id: "default", name: "Default", description: "Permissive filesystem and network access; provides no meaningful isolation." })
		assert.deepEqual(SANDBOX_BUILTIN_PROFILE_IDS.map((id) => {
			const profile = preset(id)
			assert.equal(profile.kind, "custom")
			assert.equal(profile.revision, 1)
			assert.equal(profile.filesystem.base, "selected")
			assert.deepEqual(profile.filesystem.readable, [])
			assert.deepEqual(profile.filesystem.writable, [])
			assert.deepEqual(profile.filesystem.blocked, [])
			assert.deepEqual(profile.filesystem.caches, [])
			assert.equal(profile.temporaryDirectory, "/tmp")
			assert.deepEqual(profile.environment, { passthrough: ["PATH", "HOME", "LANG"], overrides: {} })
			assert.deepEqual(validateCustomSandboxProfile(profile), profile)
			return [profile.name, profile.filesystem.workspace, profile.network]
		}), [["Workspace", "read-write", "allow"], ["Offline workspace", "read-write", "deny"], ["Read-only", "read-only", "deny"]])
	})

	it("freezes builtins and every nested policy object", () => {
		assert.ok(Object.isFrozen(SANDBOX_PROFILES))
		for (const id of SANDBOX_BUILTIN_PROFILE_IDS) {
			const profile = preset(id)
			for (const value of [profile, profile.filesystem, profile.environment, profile.environment.passthrough, profile.environment.overrides,
				profile.filesystem.readable, profile.filesystem.writable, profile.filesystem.blocked, profile.filesystem.caches]) assert.ok(Object.isFrozen(value))
			assert.throws(() => profile.filesystem.writable.push("/"), TypeError)
			assert.throws(() => { profile.network = "allow" }, TypeError)
		}
	})

	it("resolves and round-trips builtin selections without persisting them in the custom catalog", () => {
		for (const id of SANDBOX_BUILTIN_PROFILE_IDS) {
			const settings = { ...defaults, mainAgentProfileId: id, subagentProfileId: id }
			assert.deepEqual(validateSandboxSettings(settings), settings)
			assert.deepEqual(validateSandboxSettings(Settings.decode(Settings.encode(Settings.create({ sandboxSettings: settings })).finish()).sandboxSettings), settings)
			assert.deepEqual(prepareSandboxSettingsUpdate(defaults, settings), settings)
		}
	})

	it("preserves legacy custom names and IDs even if they match a newly introduced preset", () => {
		for (const [index, name] of ["Workspace", "Offline workspace", "Read-only"].entries()) {
			const id = SANDBOX_BUILTIN_PROFILE_IDS[index]
			const custom = { ...preset(id), name, revision: 9, network: "allow" as const, filesystem: { ...preset(id).filesystem, base: "broad-read" as const } }
			const settings = { ...defaults, mainAgentProfileId: id, profiles: [custom] }
			assert.deepEqual(validateSandboxSettings(settings), settings)
			assert.equal(resolveSandboxProfile(settings, id), custom)
			assert.equal(getSandboxProfiles(settings).filter((profile) => profile.id === id).length, 1)
			assert.deepEqual(prepareSandboxSettingsUpdate(settings, settings), settings)
			assert.throws(() => prepareSandboxSettingsUpdate(defaults, settings), /Reserved/)
			const namedOnly = { ...custom, id: `legacy-${index}` }
			assert.deepEqual(prepareSandboxSettingsUpdate(defaults, { ...defaults, profiles: [namedOnly] }).profiles[0], { ...namedOnly, revision: 1 })
		}
	})

	it("customizes a preset through the same draft API without changing the builtin", () => {
		const original = preset("builtin-workspace")
		const draft = sandboxProfileDraft(original, true)
		draft.name = "My workspace"
		const custom = sandboxProfileFromDraft(draft, "my-workspace", 1)
		const saved = prepareSandboxSettingsUpdate(defaults, { ...defaults, profiles: [custom] }).profiles[0]
		assert.deepEqual(saved.filesystem, original.filesystem)
		assert.deepEqual(saved.environment, original.environment)
		assert.equal(saved.network, original.network)
		assert.equal(original.name, "Workspace")
	})
})
