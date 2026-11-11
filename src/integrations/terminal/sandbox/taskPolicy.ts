import { tmpdir } from "node:os"
import path from "node:path"
import {
	resolveSandboxProfile,
	validateSandboxSettings,
	type CustomSandboxProfile,
	type SandboxSettings,
} from "@shared/SandboxSettings"
import {
	freezeSandboxTaskPolicy,
	validateSandboxTaskPolicyRequest,
	validateSandboxTaskPolicySnapshot,
	type SandboxTaskPolicyRequest,
	type SandboxTaskPolicySnapshot,
} from "@shared/SandboxTaskPolicy"
import {
	canonicalSandboxPath as canonical,
	existingSandboxBaseline,
	requireSandboxTaskHost,
	sandboxPathContains as contains,
	type SandboxPlatformPolicy,
} from "./platformPolicy"

function profilePaths(profile: CustomSandboxProfile, host: SandboxPlatformPolicy): string[] {
	return [
		...profile.filesystem.readable,
		...profile.filesystem.writable,
		...profile.filesystem.caches,
		...profile.filesystem.blocked,
		profile.temporaryDirectory,
		...(profile.filesystem.base === "selected" ? existingSandboxBaseline(host) : []),
	]
}
function grants(profile: CustomSandboxProfile, roots: readonly string[], host: SandboxPlatformPolicy) {
	const entries = new Map<string, number>()
	const add = (value: string, permission: number, baseline = false) => {
		const source = canonical(value)
		if (!baseline && entries.has(source) && entries.get(source) !== permission)
			throw new Error("Conflicting canonical sandbox grants")
		entries.set(source, permission)
	}
	if (profile.filesystem.base === "selected") for (const p of existingSandboxBaseline(host)) add(p, 1, true)
	for (const p of roots) add(p, profile.filesystem.workspace === "read-write" ? 2 : 1)
	for (const p of profile.filesystem.readable) add(p, 1)
	for (const p of [...profile.filesystem.writable, ...profile.filesystem.caches]) add(p, 2)
	return [...entries].sort(([a], [b]) => a.length - b.length)
}

/** Finite prefix policies are compared at every boundary using the enforcing host's baseline and path semantics. */
export function assertSandboxProfileNarrower(
	candidate: CustomSandboxProfile,
	ceiling: CustomSandboxProfile | null,
	roots: readonly string[],
): void {
	const host = requireSandboxTaskHost()
	if (host.identity.platform === "win32" && (candidate.filesystem.base !== "selected" || (ceiling && ceiling.filesystem.base !== "selected")))
		throw new Error("Windows task sandbox supports selected-location policies only; broad-read cannot be represented")
	if (!ceiling) return
	if (candidate.network === "allow" && ceiling.network === "deny") throw new Error("Task sandbox cannot widen network access")
	if (canonical(candidate.temporaryDirectory) !== canonical(ceiling.temporaryDirectory))
		throw new Error("Task sandbox cannot change private temporary storage")
	if (
		JSON.stringify(candidate.environment.overrides) !== JSON.stringify(ceiling.environment.overrides) ||
		candidate.environment.passthrough.some((key) => !ceiling.environment.passthrough.includes(key))
	)
		throw new Error("Task sandbox cannot widen or change the ceiling environment")
	const candidateGrants = grants(candidate, roots, host), ceilingGrants = grants(ceiling, roots, host)
	const candidateBlocks = candidate.filesystem.blocked.map((p) => canonical(p)),
		ceilingBlocks = ceiling.filesystem.blocked.map((p) => canonical(p))
	const permission = (profile: CustomSandboxProfile, grants: [string, number][], blocks: string[], target: string) => {
		if (blocks.some((p) => contains(p, target))) return 0
		let access = profile.filesystem.base === "broad-read" ? 1 : 0
		for (const [source, grant] of grants) if (contains(source, target)) access = grant
		return access
	}
	const boundaries = new Set([
		...(host.identity.platform === "win32" ? [...candidateGrants, ...ceilingGrants].map(([p]) => path.win32.parse(p).root) : ["/"]),
		...candidateGrants.map(([p]) => p), ...ceilingGrants.map(([p]) => p), ...candidateBlocks, ...ceilingBlocks,
	])
	for (const target of boundaries)
		if (permission(candidate, candidateGrants, candidateBlocks, target) > permission(ceiling, ceilingGrants, ceilingBlocks, target))
			throw new Error(`Task sandbox would widen filesystem access at ${target}`)
}

function snapshotPaths(profile: CustomSandboxProfile, ceiling: CustomSandboxProfile | null, roots: readonly string[], host: SandboxPlatformPolicy) {
	return [...new Set([...roots, ...profilePaths(profile, host), ...(ceiling ? profilePaths(ceiling, host) : [])])]
		.sort()
		.map((p) => ({ path: p, canonical: canonical(p) }))
}
function requireHost(settings: SandboxSettings): SandboxPlatformPolicy {
	if (!settings.enabled) throw new Error("Explicit task sandbox policy requires global sandboxing to be enabled")
	return requireSandboxTaskHost()
}

export function captureSandboxTaskPolicy(
	settings: SandboxSettings,
	request: SandboxTaskPolicyRequest,
	workspaceRoots: readonly string[],
): SandboxTaskPolicySnapshot {
	settings = validateSandboxSettings(settings)
	const host = requireHost(settings)
	request = validateSandboxTaskPolicyRequest(request)
	const profileHost = { platform: process.platform, temporaryDirectory: tmpdir() }
	const configured = resolveSandboxProfile(settings, settings.subagentProfileId, profileHost)
	const ceiling = "kind" in configured ? structuredClone(configured) : null
	const selected = resolveSandboxProfile(settings, request.profileId ?? settings.subagentProfileId, profileHost)
	if (!("kind" in selected) && !request.restrictions)
		throw new Error("Explicit task sandbox policy must select a restrictive profile or restrictions, not Default")
	const profile: CustomSandboxProfile = "kind" in selected ? structuredClone(selected) : {
		id: "task-policy", revision: 1, name: "Task policy", description: "Task-local command restrictions", kind: "custom",
		filesystem: { base: "broad-read", workspace: "read-write", readable: [], writable: [], blocked: [], caches: [] },
		temporaryDirectory: process.platform === "win32" ? tmpdir() : "/tmp", network: "allow", environment: { passthrough: ["PATH", "HOME", "LANG"], overrides: {} },
	}
	const r = request.restrictions
	if (r?.workspace !== undefined) profile.filesystem.workspace = r.workspace
	if (r?.hostFiles !== undefined) profile.filesystem.base = r.hostFiles === "blocked" ? "selected" : "broad-read"
	if (r?.network !== undefined) profile.network = r.network === "blocked" ? "deny" : "allow"
	if (r?.readablePaths !== undefined) profile.filesystem.readable = [...r.readablePaths]
	if (r?.writablePaths !== undefined) profile.filesystem.writable = [...r.writablePaths]
	if (r?.cachePaths !== undefined) profile.filesystem.caches = [...r.cachePaths]
	const roots = workspaceRoots.map((p) => canonical(p))
	if (
		r?.workspace === "read-only" &&
		[...profile.filesystem.writable, ...profile.filesystem.caches].some((p) =>
			roots.some((root) => contains(root, canonical(p)) || contains(canonical(p), root)),
		)
	)
		throw new Error("Read-only workspace conflicts with explicit writable/cache grants; replace those lists too")
	assertSandboxProfileNarrower(profile, ceiling, roots)
	return freezeSandboxTaskPolicy({
		version: 1,
		hostIdentity: host.identity,
		profile, ceiling, workspaceRoots: roots,
		pathIdentities: snapshotPaths(profile, ceiling, workspaceRoots, host),
	})
}

/** Reopen and launch revalidate immutable host semantics, path identities, and current user authority. */
export function resolveSandboxTaskPolicy(
	settings: SandboxSettings,
	value: SandboxTaskPolicySnapshot,
	workspaceRoots: readonly string[],
): CustomSandboxProfile {
	settings = validateSandboxSettings(settings)
	const host = requireHost(settings)
	const snapshot = validateSandboxTaskPolicySnapshot(value)
	if (snapshot.hostIdentity) {
		if (JSON.stringify(snapshot.hostIdentity) !== JSON.stringify(host.identity))
			throw new Error("Task sandbox execution host or policy semantics changed; start a new assignment")
	} else if (host.identity.platform !== "linux" || host.identity.arch !== "x64") {
		throw new Error("Legacy task sandbox policy requires its original Linux x64 execution host")
	}
	if (JSON.stringify(workspaceRoots.map((p) => canonical(p))) !== JSON.stringify(snapshot.workspaceRoots))
		throw new Error("Task sandbox workspace roots changed; start a new assignment")
	const identities = snapshotPaths(snapshot.profile, snapshot.ceiling, workspaceRoots, host)
	if (JSON.stringify(identities) !== JSON.stringify(snapshot.pathIdentities))
		throw new Error("Task sandbox path identity changed; start a new assignment")
	assertSandboxProfileNarrower(snapshot.profile, snapshot.ceiling, snapshot.workspaceRoots)
	const current = resolveSandboxProfile(settings, settings.subagentProfileId, { platform: process.platform, temporaryDirectory: tmpdir() })
	assertSandboxProfileNarrower(snapshot.profile, "kind" in current ? current : null, snapshot.workspaceRoots)
	return freezeSandboxTaskPolicy(snapshot.profile)
}
