import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { type CustomSandboxProfile, DEFAULT_SANDBOX_SETTINGS as defaults, getSandboxProfiles, prepareSandboxSettingsUpdate, resolveSandboxProfile, validateSandboxSettings } from "../SandboxSettings"
import { Settings } from "../proto/dirac/state"
import { buildSandboxStatus } from "../../integrations/terminal/sandbox/status"
import { NativeSandboxError } from "../../integrations/terminal/sandbox/types"

const profile: CustomSandboxProfile = {
	id: "local", revision: 1, kind: "custom", name: "Local", description: "User policy",
	filesystem: { base: "broad-read", workspace: "read-only", readable: ["/usr", "~/data"], writable: [], blocked: [], caches: [] },
	temporaryDirectory: "/tmp", network: "deny", environment: { passthrough: ["PATH"], overrides: { LANG: "C" } }
}
const settings = { ...defaults, mainAgentProfileId: profile.id, profiles: [profile] }

describe("custom sandbox profiles", () => {
	it("migrates only missing Phase2 catalogs, resolves one collection, and round-trips typed transport", () => {
		const { profiles: _, ...phase2 } = defaults
		assert.deepEqual(validateSandboxSettings(phase2), defaults)
		assert.deepEqual(getSandboxProfiles(settings).map((p) => p.id), ["default", "builtin-workspace", "builtin-offline-workspace", "builtin-read-only", "local"])
		assert.deepEqual(resolveSandboxProfile(settings, "local"), profile)
		assert.throws(() => validateSandboxSettings({ ...phase2, subagentProfileId: "local" }))
		const decoded = Settings.decode(Settings.encode(Settings.create({ sandboxSettings: settings })).finish())
		assert.deepEqual(validateSandboxSettings(decoded.sandboxSettings), settings)
	})
	it("rejects unknown nested fields, duplicate catalogs, malformed names, ids, enums and path/env text", () => {
		for (const invalid of [
			{ ...profile, id: "default" }, { ...profile, name: "Default" }, { ...profile, name: " " }, { ...profile, name: "Local\nname" },
			{ ...profile, kind: "default" }, { ...profile, revision: 0 }, { ...profile, revision: 1.5 }, { ...profile, network: "auto" },
			{ ...profile, filesystem: { ...profile.filesystem, base: "broad" } }, { ...profile, filesystem: { ...profile.filesystem, extra: true } },
			{ ...profile, temporaryDirectory: "relative" }, { ...profile, temporaryDirectory: "/tmp/*" }, { ...profile, temporaryDirectory: "${HOME}/tmp" },
			{ ...profile, environment: { passthrough: ["BAD=KEY"], overrides: {} } }, { ...profile, environment: { passthrough: [], overrides: { OK: false } } },
			{ ...profile, environment: { ...profile.environment, extra: true } },
		]) assert.throws(() => validateSandboxSettings({ ...settings, profiles: [invalid] }))
		assert.throws(() => validateSandboxSettings({ ...settings, profiles: [profile, profile] }))
		assert.throws(() => validateSandboxSettings({ ...settings, profiles: [profile, { ...profile, id: "other" }] }))
		assert.throws(() => validateSandboxSettings({ ...settings, profiles: null }))
	})
	it("owns revisions for new, unchanged, edited, duplicated and repaired settings", () => {
		const initial = prepareSandboxSettingsUpdate(defaults, { ...settings, profiles: [{ ...profile, revision: 900 }] })
		assert.equal(initial.profiles[0].revision, 1)
		assert.equal(prepareSandboxSettingsUpdate(initial, { ...settings, profiles: [{ ...profile, revision: 800 }] }).profiles[0].revision, 1)
		const edited = prepareSandboxSettingsUpdate(initial, { ...settings, profiles: [{ ...profile, network: "allow" }] })
		assert.equal(edited.profiles[0].revision, 2)
		assert.equal(prepareSandboxSettingsUpdate({}, settings).profiles[0].revision, 1)
		const duplicated = prepareSandboxSettingsUpdate(initial, { ...settings, profiles: [profile, { ...profile, id: "copy", name: "Copy", revision: 99 }] })
		assert.equal(duplicated.profiles[1].revision, 1)
		const reordered = { ...profile, environment: { passthrough: ["PATH"], overrides: { Z: "z", A: "a" } } }
		const normalized = validateSandboxSettings({ ...settings, profiles: [reordered] })
		assert.equal(prepareSandboxSettingsUpdate(normalized, { ...settings, profiles: [{ ...reordered, environment: { ...reordered.environment, overrides: { A: "a", Z: "z" } } }] }).profiles[0].revision, 1)
	})
	it("blocks unsupported custom controls before fallback on actual execution OS and ABI", () => {
		const capability = { available: false as const, error: new NativeSandboxError("missing", "missing-helper", "before-launch", true) }
		for (const [os, arch] of [["darwin", "ia32"], ["win32", "x64"], ["linux", "arm64"]]) {
			const status = buildSandboxStatus({ ...settings, enabled: true, allowUnsandboxedFallback: true }, capability, os, arch)
			assert.equal(status.effectiveState, "blocked")
			assert.equal(status.errorCategory, "unsupported-policy")
		}
		assert.equal(buildSandboxStatus({ ...settings, enabled: true, allowUnsandboxedFallback: true }, capability, "darwin", "x64").effectiveState, "fallback")
		assert.equal(buildSandboxStatus(settings, capability, "linux", "arm64").effectiveState, "off")
		assert.equal(buildSandboxStatus({ ...settings, enabled: true }, capability, "linux", "x64").effectiveState, "blocked")
	})
})
