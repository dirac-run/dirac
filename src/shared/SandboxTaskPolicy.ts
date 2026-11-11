import { validateSandboxPath } from "./SandboxPath"

import {
	getSandboxProfiles,
	validateSandboxSettings,
	validateCustomSandboxProfile,
	type SandboxSettings,
	type CustomSandboxProfile,
} from "./SandboxSettings"

/** Model-authored narrowing only: never enables sandboxing or authorizes fallback. */
export interface SandboxTaskPolicyRequest {
	profileId?: string
	restrictions?: {
		workspace?: "read-only" | "read-write"
		hostFiles?: "blocked" | "read-only"
		network?: "blocked" | "allowed"
		readablePaths?: string[]
		writablePaths?: string[]
		cachePaths?: string[]
	}
}

export interface SandboxPolicyHostIdentity {
	platform: string
	arch: string
	policySemantics: string
}

/** Durable immutable authority, including original path identities; not a reference to mutable settings. */
export interface SandboxTaskPolicySnapshot {
	version: 1
	/** Absent only for legacy snapshots, whose original semantics are Linux x64. */
	hostIdentity?: SandboxPolicyHostIdentity
	profile: CustomSandboxProfile
	ceiling: CustomSandboxProfile | null // null is the permissive Default ceiling
	workspaceRoots: string[]
	pathIdentities: { path: string; canonical: string }[]
}

/** Model-visible projection: environment override values may contain secrets. */
export function describeSandboxTaskProfile(profile: CustomSandboxProfile) {
	const { environment, ...policy } = profile
	return {
		...policy,
		environment: { passthrough: [...environment.passthrough], overrideKeys: Object.keys(environment.overrides) },
	}
}

export function sandboxTaskPolicyCatalog(settings: SandboxSettings) {
	const valid = validateSandboxSettings(settings)
	return {
		enabled: valid.enabled,
		ceilingProfileId: valid.subagentProfileId,
		profiles: getSandboxProfiles(valid).map((p) => ("kind" in p ? describeSandboxTaskProfile(p) : p)),
		taskPolicyFallback: "forbidden",
		scope: "commands only; direct tools unchanged",
		restrictions:
			"Narrowing only. Path lists replace profile lists; omitted fields retain them. Existing canonical paths required. Unsupported or widening requests fail closed.",
	}
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox task policy must be an object")
	for (const key of Object.keys(value))
		if (!fields.includes(key)) throw new Error(`Unsupported sandbox task policy field: ${key}`)
	return value as Record<string, unknown>
}

export function validateSandboxTaskPolicyRequest(value: unknown): SandboxTaskPolicyRequest {
	const input = record(value, ["profileId", "restrictions"])
	const result: SandboxTaskPolicyRequest = {}
	if (input.profileId !== undefined) {
		if (typeof input.profileId !== "string" || !input.profileId.trim()) throw new Error("Sandbox profileId must be non-empty")
		result.profileId = input.profileId
	}
	if (input.restrictions !== undefined) {
		const restrictions = record(input.restrictions, [
			"workspace",
			"hostFiles",
			"network",
			"readablePaths",
			"writablePaths",
			"cachePaths",
		])
		const parsed: NonNullable<SandboxTaskPolicyRequest["restrictions"]> = {}
		for (const [key, choices] of Object.entries({
			workspace: ["read-only", "read-write"],
			hostFiles: ["blocked", "read-only"],
			network: ["blocked", "allowed"],
		})) {
			if (restrictions[key] === undefined) continue
			if (!choices.includes(restrictions[key] as string)) throw new Error(`Invalid sandbox restriction: ${key}`)
			Object.assign(parsed, { [key]: restrictions[key] })
		}
		for (const key of ["readablePaths", "writablePaths", "cachePaths"] as const) {
			if (restrictions[key] === undefined) continue
			const paths = restrictions[key]
			if (!Array.isArray(paths) || paths.length > 64)
				throw new Error(`Invalid sandbox ${key}; use at most 64 existing explicit absolute paths`)
			parsed[key] = paths.map(validateSandboxPath)
		}
		result.restrictions = parsed
	}
	if (!result.profileId && (!result.restrictions || !Object.keys(result.restrictions).length))
		throw new Error("Sandbox task policy requires a profileId or restrictions")
	return result
}

export function validateSandboxTaskPolicySnapshot(value: unknown): SandboxTaskPolicySnapshot {
	const input = record(value, ["version", "hostIdentity", "profile", "ceiling", "workspaceRoots", "pathIdentities"])
	if (input.version !== 1) throw new Error("Unsupported sandbox task policy version")
	let hostIdentity: SandboxPolicyHostIdentity | undefined
	if (Object.hasOwn(input, "hostIdentity")) {
		const identity = record(input.hostIdentity, ["platform", "arch", "policySemantics"])
		for (const key of ["platform", "arch", "policySemantics"])
			if (typeof identity[key] !== "string" || !/^[a-zA-Z0-9_-]+$/.test(identity[key] as string))
				throw new Error("Invalid saved sandbox host identity")
		hostIdentity = { platform: identity.platform as string, arch: identity.arch as string, policySemantics: identity.policySemantics as string }
	}
	if (!Array.isArray(input.workspaceRoots) || !Array.isArray(input.pathIdentities))
		throw new Error("Invalid saved sandbox path identities")
	const absolute = (value: unknown): string => {
		const valid = validateSandboxPath(value)
		if (valid.startsWith("~/")) throw new Error("Saved sandbox identities must be absolute")
		return valid
	}
	const pathIdentities = input.pathIdentities.map((value) => {
		const identity = record(value, ["path", "canonical"])
		return { path: validateSandboxPath(identity.path), canonical: absolute(identity.canonical) }
	})
	return {
		version: 1,
		...(hostIdentity ? { hostIdentity } : {}),
		profile: validateCustomSandboxProfile(input.profile),
		ceiling: input.ceiling === null ? null : validateCustomSandboxProfile(input.ceiling),
		workspaceRoots: input.workspaceRoots.map(absolute),
		pathIdentities,
	}
}

export function freezeSandboxTaskPolicy<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeSandboxTaskPolicy(child)
		Object.freeze(value)
	}
	return value
}
