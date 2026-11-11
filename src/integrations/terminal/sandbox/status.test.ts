import assert from "node:assert/strict"
import { DEFAULT_SANDBOX_SETTINGS as defaults, resolveSandboxProfile } from "@shared/SandboxSettings"
import { describe, it } from "mocha"
import { buildSandboxStatus } from "./status"
import { NativeSandboxError } from "./types"

const missing = {
	available: false as const,
	error: new NativeSandboxError("Missing helper", "missing-helper", "before-launch", true),
}

describe("execution-host sandbox status", () => {
	it("distinguishes master off, blocked and explicitly permitted fallback", () => {
		assert.equal(buildSandboxStatus(defaults, missing, "linux").effectiveState, "off")
		const required = buildSandboxStatus({ ...defaults, enabled: true }, missing, "linux")
		assert.equal(required.effectiveState, "blocked")
		assert.equal(required.hostPlatform, "linux")
		assert.equal(required.allowUnsandboxedFallback, false)
		assert.match(required.remediation!, /Bubblewrap.*Restart/)
		assert.equal(
			buildSandboxStatus({ ...defaults, enabled: true, allowUnsandboxedFallback: true }, missing, "linux").effectiveState,
			"fallback",
		)
	})
	it("reports backend readiness and limitations, never meaningful protection", () => {
		const status = buildSandboxStatus(
			{ ...defaults, enabled: true },
			{ available: true, backend: "bubblewrap", helperPath: "/usr/bin/bwrap", limitations: ["PID namespace"] },
			"linux",
		)
		assert.equal(status.effectiveState, "native")
		assert.equal(status.backend, "bubblewrap")
		assert.ok(status.limitations.some((line) => line.includes("no meaningful isolation")))
		assert.ok(status.limitations.includes("PID namespace"))
	})
	it("uses probed macOS and Windows controls instead of a Linux-only custom-policy gate", () => {
		const settings = { ...defaults, enabled: true, mainAgentProfileId: "builtin-workspace", subagentProfileId: "builtin-workspace" }
		for (const [hostPlatform, backend] of [["darwin", "seatbelt"], ["win32", "windows-mxc"]] as const) {
			const capability = {
				available: true as const, backend, helperPath: "helper", limitations: ["Native-only limitation"],
				policyCapabilities: { restrictiveProfiles: true, taskPolicies: false, unsupportedControls: ["taskPolicies", "filesystem.broad-read"] },
			}
			const status = buildSandboxStatus(settings, capability, hostPlatform, "x64")
			assert.equal(status.effectiveState, "native")
			assert.ok(status.limitations.includes("Native-only limitation"))
			assert.ok(status.limitations.some((line) => line.includes("host-backed")))
			assert.equal(buildSandboxStatus(settings, { ...capability, policyCapabilities: undefined }, hostPlatform, "x64").effectiveState, "blocked")
			assert.equal(buildSandboxStatus({ ...settings, enabled: false }, capability, hostPlatform, "x64").effectiveState, "off")
		}
	})
	it("never reports unsupported Windows controls or foreign custom paths as native or eligible fallback", () => {
		const preset = resolveSandboxProfile(defaults, "builtin-workspace")
		assert.ok("kind" in preset)
		const custom = { ...structuredClone(preset), id: "custom", name: "Custom", temporaryDirectory: "C:\\Temp" }
		const settings = { ...defaults, enabled: true, allowUnsandboxedFallback: true, mainAgentProfileId: custom.id, subagentProfileId: custom.id, profiles: [custom] }
		const capability = {
			available: true as const, backend: "windows-mxc" as const, helperPath: "helper", limitations: [],
			policyCapabilities: { restrictiveProfiles: true, taskPolicies: true, unsupportedControls: ["filesystem.broad-read", "network.allow"] }
		}
		assert.equal(buildSandboxStatus(settings, capability, "win32", "x64").effectiveState, "blocked")
		custom.network = "deny"
		assert.equal(buildSandboxStatus(settings, capability, "win32", "x64").effectiveState, "native")
		custom.filesystem.base = "broad-read"
		assert.equal(buildSandboxStatus(settings, capability, "win32", "x64").errorCategory, "unsupported-policy")
		custom.filesystem.base = "selected"
		custom.temporaryDirectory = "/tmp"
		assert.equal(buildSandboxStatus(settings, missing, "win32", "x64").effectiveState, "blocked")
		assert.equal(buildSandboxStatus({ ...defaults, enabled: true, allowUnsandboxedFallback: true }, missing, "win32", "x64").errorCategory, "unsupported-policy")
	})
	it("blocks invalid configuration even when disabled or fallback was requested", () => {
		const status = buildSandboxStatus(
			{ ...defaults, subagentProfileId: "bad", allowUnsandboxedFallback: true },
			missing,
			"linux",
		)
		assert.equal(status.effectiveState, "configuration-error")
		assert.equal(status.requestedEnabled, undefined)
		assert.equal(status.allowUnsandboxedFallback, undefined)
		assert.equal(status.errorCategory, "invalid-configuration")
	})
})
