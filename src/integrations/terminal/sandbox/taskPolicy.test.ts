import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { DEFAULT_SANDBOX_SETTINGS, type CustomSandboxProfile, type SandboxSettings } from "@shared/SandboxSettings"
import { validateSandboxTaskPolicyRequest, validateSandboxTaskPolicySnapshot } from "@shared/SandboxTaskPolicy"
import { assertSandboxProfileNarrower, captureSandboxTaskPolicy, resolveSandboxTaskPolicy } from "./taskPolicy"
import { prepareLinuxPolicy } from "./linuxPolicy"

// Policy comparison tests do not invoke the native launcher or require bubblewrap.
describe("task-local sandbox narrowing", () => {
	let root: string, workspace: string, outside: string, temp: string
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "dirac-task-policy-"))
		workspace = path.join(root, "workspace")
		outside = path.join(root, "outside")
		temp = path.join(root, "private-temp")
		for (const p of [
			workspace,
			outside,
			temp,
			path.join(workspace, "readonly"),
			path.join(workspace, "blocked"),
			path.join(root, "workspace-other"),
		])
			mkdirSync(p, { recursive: true })
	})
	afterEach(() => rmSync(root, { recursive: true, force: true }))
	const profile = (temp: string): CustomSandboxProfile => ({
		id: "ceiling",
		revision: 1,
		name: "Ceiling",
		description: "",
		kind: "custom",
		filesystem: { base: "selected", workspace: "read-write", readable: [], writable: [], blocked: [], caches: [] },
		temporaryDirectory: temp,
		network: "deny",
		environment: { passthrough: ["PATH"], overrides: {} },
	})
	const settings = (p: CustomSandboxProfile): SandboxSettings => ({
		...DEFAULT_SANDBOX_SETTINGS,
		enabled: true,
		subagentProfileId: p.id,
		profiles: [p],
	})

	it("binds snapshots to host policy semantics and accepts legacy snapshots only under original Linux semantics", function () {
		if (process.platform !== "linux" || process.arch !== "x64") this.skip()
		const initial = settings(profile(temp))
		const snapshot = captureSandboxTaskPolicy(initial, { restrictions: { workspace: "read-only" } }, [workspace])
		assert.equal(snapshot.hostIdentity?.platform, "linux")
		assert.ok(Object.isFrozen(snapshot.hostIdentity))
		for (const identity of [
			{ ...snapshot.hostIdentity, platform: "darwin" },
			{ ...snapshot.hostIdentity, arch: "arm64" },
			{ ...snapshot.hostIdentity, policySemantics: "future-v2" },
		]) assert.throws(() => resolveSandboxTaskPolicy(initial, { ...snapshot, hostIdentity: identity } as typeof snapshot, [workspace]), /host or policy semantics changed/)
		const { hostIdentity: _, ...legacy } = snapshot
		assert.doesNotThrow(() => resolveSandboxTaskPolicy(initial, legacy, [workspace]))
		for (const malformed of [null, undefined, {}, { platform: "linux", arch: "x64" }, { ...snapshot.hostIdentity, extra: true }])
			assert.throws(() => validateSandboxTaskPolicySnapshot({ ...snapshot, hostIdentity: malformed }), /identity|policy field|object/)
	})

	it("rejects settings/fallback/environment authority and malformed or ambiguous requests", () => {
		for (const request of [
			{ enabled: true },
			{ allowUnsandboxedFallback: true },
			{ restrictions: { environment: {} } },
			{},
			{ restrictions: { network: "deny" } },
			{ restrictions: { writablePaths: ["relative"] } },
		])
			assert.throws(() => validateSandboxTaskPolicyRequest(request), /sandbox/i)
	})

	it("compares canonical boundaries, including RO child exceptions and blocked descendants", () => {
		const ceiling = profile(temp)
		ceiling.filesystem.readable = [path.join(workspace, "readonly")]
		ceiling.filesystem.blocked = [path.join(workspace, "blocked")]
		const candidate = structuredClone(ceiling)
		candidate.filesystem.readable = []
		assert.throws(() => assertSandboxProfileNarrower(candidate, ceiling, [workspace]), /widen/)
		candidate.filesystem.readable = [...ceiling.filesystem.readable]
		candidate.filesystem.blocked = []
		assert.throws(() => assertSandboxProfileNarrower(candidate, ceiling, [workspace]), /widen/)
		candidate.filesystem.blocked = [...ceiling.filesystem.blocked]
		assert.doesNotThrow(() => assertSandboxProfileNarrower(candidate, ceiling, [workspace]))
	})

	it("does not confuse sibling prefixes, cache grants, or symlinks with authorized writes", () => {
		const ceiling = profile(temp),
			candidate = structuredClone(ceiling)
		candidate.filesystem.caches = [path.join(root, "workspace-other")]
		assert.throws(() => assertSandboxProfileNarrower(candidate, ceiling, [workspace]), /widen/)
		const alias = path.join(root, "alias")
		symlinkSync(outside, alias)
		candidate.filesystem.caches = [alias]
		assert.throws(() => assertSandboxProfileNarrower(candidate, ceiling, [workspace]), /widen/)
	})

	it("rejects changing private temp, environment overrides, passthrough, and network", () => {
		const ceiling = profile(temp)
		for (const mutate of [
			(p: CustomSandboxProfile) => {
				p.temporaryDirectory = outside
			},
			(p: CustomSandboxProfile) => {
				p.environment.overrides.NEW = "value"
			},
			(p: CustomSandboxProfile) => {
				p.environment.passthrough.push("TOKEN")
			},
			(p: CustomSandboxProfile) => {
				p.network = "allow"
			},
		]) {
			const candidate = structuredClone(ceiling)
			mutate(candidate)
			assert.throws(() => assertSandboxProfileNarrower(candidate, ceiling, [workspace]), /cannot/)
		}
	})

	it("captures durable immutable choices and cannot widen after settings edits or catalog deletion", function () {
		if (process.platform !== "linux" || process.arch !== "x64") this.skip()
		const ceiling = profile(temp),
			initial = settings(ceiling)
		const snapshot = captureSandboxTaskPolicy(initial, { restrictions: { workspace: "read-only" } }, [workspace])
		assert.ok(Object.isFrozen(snapshot.profile.filesystem))
		const savedPolicy = validateSandboxTaskPolicySnapshot(JSON.parse(JSON.stringify(snapshot)))
		const expanded = { ...DEFAULT_SANDBOX_SETTINGS, enabled: true, allowUnsandboxedFallback: true }
		assert.equal(resolveSandboxTaskPolicy(expanded, savedPolicy, [workspace]).filesystem.workspace, "read-only")
		assert.equal(resolveSandboxTaskPolicy(initial, savedPolicy, [workspace]).network, "deny")
		const tighter = structuredClone(initial)
		tighter.profiles[0].filesystem.blocked.push(outside)
		// Already inaccessible outside paths do not invalidate a safe snapshot.
		assert.doesNotThrow(() => resolveSandboxTaskPolicy(tighter, savedPolicy, [workspace]))
		tighter.profiles[0].filesystem.blocked.push(workspace)
		assert.throws(() => resolveSandboxTaskPolicy(tighter, savedPolicy, [workspace]), /widen/)
		assert.throws(() => resolveSandboxTaskPolicy({ ...initial, enabled: false }, savedPolicy, [workspace]), /enabled/)
	})

	it("rejects transient symlink retargets inside native preparation, even when restored before final authorization", function () {
		if (process.platform !== "linux" || process.arch !== "x64") this.skip()
		const alias = path.join(root, "alias")
		symlinkSync(outside, alias)
		const ceiling = profile(temp)
		ceiling.filesystem.readable = [alias]
		const initial = settings(ceiling)
		const snapshot = captureSandboxTaskPolicy(initial, { restrictions: { workspace: "read-only" } }, [workspace])
		unlinkSync(alias)
		symlinkSync(path.join(root, "workspace-other"), alias)
		try {
			assert.throws(
				() =>
					prepareLinuxPolicy(
						{
							executable: "/usr/bin/true",
							args: [],
							cwd: workspace,
							env: {},
							policy: snapshot.profile,
							context: {
								workspaceRoots: [workspace],
								protectedPaths: [path.join(workspace, "blocked")],
								pathIdentities: snapshot.pathIdentities,
							},
						},
						snapshot.profile,
					),
				/identity changed/,
			)
		} finally {
			unlinkSync(alias)
			symlinkSync(outside, alias)
		}
		assert.doesNotThrow(() => resolveSandboxTaskPolicy(initial, snapshot, [workspace]))
	})

	it("pins source symlink identities through reopen and revalidates current ceiling canonical grants", function () {
		if (process.platform !== "linux" || process.arch !== "x64") this.skip()
		const alias = path.join(root, "alias")
		symlinkSync(outside, alias)
		const ceiling = profile(temp)
		ceiling.filesystem.readable = [alias]
		const initial = settings(ceiling)
		const snapshot = captureSandboxTaskPolicy(initial, { restrictions: { network: "blocked" } }, [workspace])
		unlinkSync(alias)
		symlinkSync(workspace, alias)
		assert.throws(() => resolveSandboxTaskPolicy(initial, snapshot, [workspace]), /identity changed/)
	})

	it("fails explicit capture when off and rejects broad-read/allowed network above ceiling", function () {
		if (process.platform !== "linux" || process.arch !== "x64") this.skip()
		const initial = settings(profile(temp))
		assert.throws(
			() => captureSandboxTaskPolicy({ ...initial, enabled: false }, { profileId: "ceiling" }, [workspace]),
			/enabled/,
		)
		assert.throws(() => captureSandboxTaskPolicy(initial, { restrictions: { hostFiles: "read-only" } }, [workspace]), /widen/)
		assert.throws(() => captureSandboxTaskPolicy(initial, { restrictions: { network: "allowed" } }, [workspace]), /network/)
	})
})
