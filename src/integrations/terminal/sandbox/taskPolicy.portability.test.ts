import assert from "node:assert/strict"
import fs from "node:fs"
import sinon from "sinon"
import { describe, it } from "mocha"
import { captureSandboxExecution } from "@shared/SandboxExecution"
import { DEFAULT_SANDBOX_SETTINGS, type CustomSandboxProfile } from "@shared/SandboxSettings"
import { captureSandboxTaskPolicy, resolveSandboxTaskPolicy } from "./taskPolicy"
import { canonicalSandboxPath, sandboxPlatformPolicy } from "./platformPolicy"
import { windowsReadableBaseline } from "./windowsPolicy"

/** Translation/authority tests on Linux, NOT evidence of native Windows or macOS containment. */
describe("task policy portability", () => {
	it("keeps normal configured macOS restrictive profiles usable while rejecting explicit delegated narrowing", () => {
		const stub = sinon.stub(process, "platform").value("darwin")
		try {
			const settings = { ...DEFAULT_SANDBOX_SETTINGS, enabled: true, mainAgentProfileId: "builtin-workspace", subagentProfileId: "builtin-offline-workspace" }
			assert.equal(captureSandboxExecution(settings, false).profileId, "builtin-workspace")
			assert.equal(captureSandboxExecution(settings, true).profileId, "builtin-offline-workspace")
			assert.throws(() => captureSandboxTaskPolicy(settings, { restrictions: { workspace: "read-only" } }, ["/workspace"]), /path identity semantics are not validated/)
		} finally { stub.restore() }
	})

	it("uses the enforced Windows runtime baseline and rejects task widening and legacy cross-platform snapshots", () => {
		const stats = fs.statSync(__filename)
		const sandbox = sinon.createSandbox()
		try {
			sandbox.stub(process, "platform").value("win32")
			sandbox.stub(process, "arch").value("x64")
			sandbox.stub(process, "env").value({ SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" })
			sandbox.stub(fs, "statSync").returns(stats)
			sandbox.stub(fs, "lstatSync").returns(stats)
			sandbox.stub(fs.realpathSync, "native").callsFake(((p: fs.PathLike) => p.toString()) as typeof fs.realpathSync.native)
			const profile: CustomSandboxProfile = {
				id: "ceiling", revision: 1, name: "Ceiling", description: "", kind: "custom",
				filesystem: { base: "selected", workspace: "read-write", readable: [], writable: [], blocked: [], caches: [] },
				temporaryDirectory: "D:\\private-temp", network: "deny", environment: { passthrough: ["PATH"], overrides: {} },
			}
			const settings = { ...DEFAULT_SANDBOX_SETTINGS, enabled: true, subagentProfileId: profile.id, profiles: [profile] }
			assert.deepEqual(sandboxPlatformPolicy("win32", "x64").readableBaseline, windowsReadableBaseline(process.env))
			const snapshot = captureSandboxTaskPolicy(settings, { restrictions: { workspace: "read-only" } }, ["C:\\Work"])
			assert.equal(snapshot.hostIdentity?.policySemantics, "win32-mxc-drive-v1")
			assert.ok(snapshot.pathIdentities.some((identity) => identity.canonical === "c:\\windows"))
			assert.equal(resolveSandboxTaskPolicy(settings, snapshot, ["C:\\Work"]).filesystem.workspace, "read-only")
			assert.throws(() => captureSandboxTaskPolicy(settings, { restrictions: { cachePaths: ["D:\\outside"] } }, ["C:\\Work"]), /widen/)
			assert.throws(() => captureSandboxTaskPolicy(settings, { restrictions: { hostFiles: "read-only" } }, ["C:\\Work"]), /selected-location/)
			const { hostIdentity: _, ...legacy } = snapshot
			assert.throws(() => resolveSandboxTaskPolicy(settings, legacy, ["C:\\Work"]), /original Linux/)
			assert.throws(() => canonicalSandboxPath("/tmp"), /drive-absolute/)
		} finally { sandbox.restore() }
	})
})
