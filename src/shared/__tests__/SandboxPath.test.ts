import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { validateSandboxPath } from "../SandboxPath"
import { DEFAULT_SANDBOX_SETTINGS, resolveSandboxProfile, validateCustomSandboxProfile } from "../SandboxSettings"
import { captureSandboxExecution } from "../SandboxExecution"
import { validateSandboxTaskPolicyRequest } from "../SandboxTaskPolicy"

describe("portable sandbox settings paths", () => {
	it("preserves POSIX paths and accepts explicit Windows drive paths without guessing the execution host", () => {
		for (const p of ["/tmp", "~/cache", "C:\\", "C:\\work\\project", "D:/build/cache"])
			assert.equal(validateSandboxPath(p), p)
		assert.deepEqual(validateSandboxTaskPolicyRequest({ restrictions: { readablePaths: ["C:\\work"] } }), { restrictions: { readablePaths: ["C:\\work"] } })
	})
	it("rejects Windows UNC/device/stream/alias/relative/ambiguous paths", () => {
		for (const p of ["C:work", "\\work", "\\\\server\\share", "//server/share", "\\\\?\\C:\\work", "\\\\.\\C:\\work", "C:\\work:stream", "C:\\..\\work", "C:\\work\\.\\child", "C:\\work.\\child", "C:\\work ", "C:\\NUL", "C:\\aux.txt", "C:\\PROGRA~1", "C:\\wörk", "C:\\a\\\\b"])
			assert.throws(() => validateSandboxPath(p), /sandbox|Windows/i, p)
	})
	it("adapts genuine Windows preset temp paths explicitly without mutating presets or saved custom paths", () => {
		const host = { platform: "win32", temporaryDirectory: "C:\\Users\\dev\\Temp" }
		const original = resolveSandboxProfile(DEFAULT_SANDBOX_SETTINGS, "builtin-workspace")
		assert.ok("kind" in original)
		const settings = { ...DEFAULT_SANDBOX_SETTINGS, subagentProfileId: original.id }
		assert.equal(captureSandboxExecution(settings, true, host).profile.id, original.id)
		const adapted = resolveSandboxProfile(settings, original.id, host)
		assert.ok("kind" in adapted)
		assert.equal(adapted.temporaryDirectory, host.temporaryDirectory)
		assert.equal(original.temporaryDirectory, "/tmp")
		const custom = validateCustomSandboxProfile(structuredClone(original))
		const customSettings = { ...settings, profiles: [custom] }
		const saved = resolveSandboxProfile(customSettings, custom.id, host)
		assert.ok("kind" in saved)
		assert.equal(saved.temporaryDirectory, "/tmp")
		assert.throws(() => resolveSandboxProfile(settings, original.id, { ...host, temporaryDirectory: "/tmp" }), /drive-absolute/)
	})
})
