import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { SANDBOX_CAPABILITY_ROWS, sandboxAdditionalFolders, sandboxCapabilityValue, updateSandboxAdditionalFolders, updateSandboxCapability } from "../SandboxCapabilities"
import { type CustomSandboxProfile, DEFAULT_SANDBOX_SETTINGS, prepareSandboxSettingsUpdate, validateCustomSandboxProfile } from "../SandboxSettings"
import { sandboxProfileDraft, sandboxProfileFromDraft } from "../settings-presentation"

const advanced: CustomSandboxProfile = {
	id: "advanced", revision: 7, kind: "custom", name: "Advanced", description: "Keep every rule",
	filesystem: { base: "broad-read", workspace: "read-only", readable: ["~/datasets", "/opt/sdk"], writable: ["/opt/build"], blocked: ["~/secrets"], caches: ["~/.npm", "~/.cache/pip"] },
	temporaryDirectory: "/private-temp", network: "deny",
	environment: { passthrough: ["PATH", "LANG", "CUSTOM"], overrides: { CUSTOM: " spaces = remain ", LANG: "C" } },
}

const restored = (draft: ReturnType<typeof sandboxProfileDraft>) => validateCustomSandboxProfile(sandboxProfileFromDraft(draft, advanced.id, advanced.revision))

describe("shared sandbox capability editor", () => {
	it("uses row-specific labeled options rather than fixed permission columns", () => {
		assert.deepEqual(SANDBOX_CAPABILITY_ROWS.map(({ key, options }) => [key, options.map(({ value, label }) => [value, label])]), [
			["workspace", [["read-only", "Read-only"], ["read-write", "Read & write"]]],
			["hostFiles", [["blocked", "Blocked"], ["read-only", "Read-only"]]],
			["network", [["blocked", "Blocked"], ["allowed", "Allowed"]]],
			["packageCaches", [["blocked", "No extra access"], ["allowed", "Read & write"]]],
		])
	})

	it("creates custom drafts from restrictive Workspace rather than broad host access", () => {
		const draft = sandboxProfileDraft()
		assert.equal(draft.base, "selected")
		assert.equal(draft.workspace, "read-write")
		assert.equal(draft.network, "allow")
		assert.equal(draft.temporaryDirectory, "/tmp")
		assert.equal(draft.passthrough, "PATH\nHOME\nLANG")
		for (const field of ["readable", "writable", "blocked", "caches", "overrides"] as const) assert.equal(draft[field], "")
	})

	it("round-trips every advanced field and does not increment revision on unchanged save", () => {
		const draft = sandboxProfileDraft(advanced)
		assert.deepEqual(restored(draft), advanced)
		const settings = { ...DEFAULT_SANDBOX_SETTINGS, profiles: [advanced] }
		assert.equal(prepareSandboxSettingsUpdate(settings, { ...settings, profiles: [restored(draft)] }).profiles[0].revision, 7)
		assert.equal(sandboxProfileDraft(advanced, true).name, "Advanced copy")
	})

	it("reads capabilities without rewriting advanced settings and changes only the selected field", () => {
		const draft = sandboxProfileDraft(advanced)
		assert.deepEqual(SANDBOX_CAPABILITY_ROWS.map(({ key }) => sandboxCapabilityValue(draft, key)), ["read-only", "read-only", "blocked", "allowed"])
		assert.deepEqual(restored(draft), advanced)
		assert.deepEqual(updateSandboxCapability(draft, "workspace", "read-write"), { ...draft, workspace: "read-write" })
		assert.deepEqual(updateSandboxCapability(draft, "hostFiles", "blocked"), { ...draft, base: "selected" })
		assert.deepEqual(updateSandboxCapability(draft, "hostFiles", "read-only"), draft)
		assert.deepEqual(updateSandboxCapability(draft, "network", "allowed"), { ...draft, network: "allow" })
		assert.deepEqual(updateSandboxCapability(draft, "network", "blocked"), draft)
		assert.throws(() => updateSandboxCapability(draft, "hostFiles", "read-write"), /Invalid/)
		assert.deepEqual(restored(draft), advanced)
	})

	it("requires explicit precise cache directories and never invents home or package-manager grants", () => {
		const draft = sandboxProfileDraft()
		assert.equal(sandboxCapabilityValue(draft, "packageCaches"), "blocked")
		assert.throws(() => updateSandboxCapability(draft, "packageCaches", "allowed"), /precise/)
		for (const paths of [[], [""], ["/"], ["~/"]]) assert.throws(() => updateSandboxCapability(draft, "packageCaches", "allowed", paths), /precise/)
		const enabled = updateSandboxCapability(draft, "packageCaches", "allowed", ["~/.npm", "/var/cache/project"])
		assert.deepEqual(enabled, { ...draft, caches: "~/.npm\n/var/cache/project" })
		assert.equal(sandboxCapabilityValue(enabled, "packageCaches"), "allowed")
		assert.deepEqual(updateSandboxCapability(enabled, "packageCaches", "blocked"), draft)
	})

	it("retains folder grant order, duplicates and blocked children until explicitly edited", () => {
		const draft = sandboxProfileDraft(advanced)
		draft.readable += "\n~/datasets"
		const folders = sandboxAdditionalFolders(draft)
		assert.deepEqual(folders, [
			{ path: "~/datasets", access: "read-only" }, { path: "/opt/sdk", access: "read-only" }, { path: "~/datasets", access: "read-only" },
			{ path: "/opt/build", access: "read-write" }, { path: "~/secrets", access: "blocked" },
		])
		assert.deepEqual(updateSandboxAdditionalFolders(draft, folders), draft)
		const edited = updateSandboxAdditionalFolders(draft, [{ path: "/extra", access: "read-write" }, { path: "/extra/private", access: "blocked" }])
		assert.deepEqual(edited, { ...draft, readable: "", writable: "/extra", blocked: "/extra/private" })
	})
})
