import { validateSandboxPath } from "./SandboxPath"

/** Trusted, user-global command execution settings. Default is not meaningful isolation. */
export interface CustomSandboxProfile {
	id: string
	revision: number
	name: string
	description: string
	kind: "custom"
	filesystem: { base: "broad-read" | "selected"; workspace: "read-only" | "read-write"; readable: string[]; writable: string[]; blocked: string[]; caches: string[] }
	temporaryDirectory: string
	network: "allow" | "deny"
	environment: { passthrough: string[]; overrides: Record<string, string> }
}

export interface SandboxSettings {
	enabled: boolean
	allowUnsandboxedFallback: boolean
	mainAgentProfileId: string
	subagentProfileId: string
	profiles: CustomSandboxProfile[]
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
	enabled: false,
	allowUnsandboxedFallback: false,
	mainAgentProfileId: "default",
	subagentProfileId: "default",
	profiles: [],
}

export const SANDBOX_BUILTIN_PROFILE_IDS = Object.freeze(["builtin-workspace", "builtin-offline-workspace", "builtin-read-only"] as const)

/** Full execution policies; freezing every owned object prevents edits to the shared presets. */
function builtinProfile(id: string, name: string, description: string, workspace: CustomSandboxProfile["filesystem"]["workspace"], network: CustomSandboxProfile["network"]): CustomSandboxProfile {
	const profile: CustomSandboxProfile = {
		id, revision: 1, kind: "custom", name, description,
		filesystem: { base: "selected", workspace, readable: [], writable: [], blocked: [], caches: [] },
		temporaryDirectory: "/tmp", network,
		environment: { passthrough: ["PATH", "HOME", "LANG"], overrides: {} },
	}
	for (const paths of [profile.filesystem.readable, profile.filesystem.writable, profile.filesystem.blocked, profile.filesystem.caches, profile.environment.passthrough]) Object.freeze(paths)
	Object.freeze(profile.filesystem)
	Object.freeze(profile.environment.overrides)
	Object.freeze(profile.environment)
	return Object.freeze(profile)
}

export const SANDBOX_PROFILES = Object.freeze([
	Object.freeze({ id: "default", name: "Default", description: "Permissive filesystem and network access; provides no meaningful isolation." }),
	builtinProfile(SANDBOX_BUILTIN_PROFILE_IDS[0], "Workspace", "System runtime and read/write workspace access, with network access allowed.", "read-write", "allow"),
	builtinProfile(SANDBOX_BUILTIN_PROFILE_IDS[1], "Offline workspace", "System runtime and read/write workspace access, with network access blocked.", "read-write", "deny"),
	builtinProfile(SANDBOX_BUILTIN_PROFILE_IDS[2], "Read-only", "System runtime and read-only workspace access, with network access blocked.", "read-only", "deny"),
])

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox configuration must be an object")
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown sandbox field: ${key}`)
	return value as Record<string, unknown>
}
function text(value: unknown, label: string, empty = false): string {
	if (typeof value !== "string" || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid sandbox ${label}`)
	return value
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
	if (!allowed.includes(value as T)) throw new Error(`Sandbox value must be one of: ${allowed.join(", ")}`)
	return value as T
}
const path = validateSandboxPath
function list(value: unknown, validate: (item: unknown) => string): string[] {
	if (!Array.isArray(value)) throw new Error("Sandbox path/environment lists must be arrays")
	return value.map(validate)
}
function envKey(value: unknown): string {
	const key = text(value, "environment key")
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid sandbox environment key")
	return key
}
export function validateCustomSandboxProfile(value: unknown): CustomSandboxProfile {
	const p = object(value, ["id", "revision", "name", "description", "kind", "filesystem", "temporaryDirectory", "network", "environment"])
	const id = text(p.id, "profile id")
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || id.toLowerCase() === "default") throw new Error("Invalid or reserved sandbox profile id")
	const name = text(p.name, "profile name")
	if (name !== name.trim() || name.length > 100 || name.toLowerCase() === "default") throw new Error("Invalid or reserved sandbox profile name")
	if (!Number.isSafeInteger(p.revision) || (p.revision as number) < 1) throw new Error("Sandbox profile revision must be a positive safe integer")
	const f = object(p.filesystem, ["base", "workspace", "readable", "writable", "blocked", "caches"])
	const e = object(p.environment, ["passthrough", "overrides"])
	if (!e.overrides || typeof e.overrides !== "object" || Array.isArray(e.overrides)) throw new Error("Sandbox environment overrides must be a map")
	return {
		id, revision: p.revision as number, name, description: text(p.description, "description", true), kind: choice(p.kind, ["custom"]),
		filesystem: { base: choice(f.base, ["broad-read", "selected"]), workspace: choice(f.workspace, ["read-only", "read-write"]), readable: list(f.readable, path), writable: list(f.writable, path), blocked: list(f.blocked, path), caches: list(f.caches, path) },
		temporaryDirectory: path(p.temporaryDirectory), network: choice(p.network, ["allow", "deny"]),
		environment: { passthrough: list(e.passthrough, envKey), overrides: Object.fromEntries(Object.entries(e.overrides).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [envKey(key), text(value, "environment value", true)])) },
	}
}

/** Legacy custom IDs and names keep their identity even when a newly added preset collides. */
export function getSandboxProfiles(settings: SandboxSettings) {
	const customIds = new Set(settings.profiles.map((profile) => profile.id))
	return [...SANDBOX_PROFILES.filter((profile) => !customIds.has(profile.id)), ...settings.profiles]
}
/** Host adaptation applies only to genuine presets, never saved custom profiles (including colliding legacy IDs). */
export interface SandboxProfileHost {
	platform: string
	temporaryDirectory: string
}
export function resolveSandboxProfile(settings: SandboxSettings, id: string, host?: SandboxProfileHost) {
	const profile = getSandboxProfiles(settings).find((entry) => entry.id === id)
	if (!profile) throw new Error(`Unknown sandbox profile: ${id}`)
	if (host?.platform === "win32" && "kind" in profile && !settings.profiles.some((custom) => custom.id === id)) {
		const temporaryDirectory = validateSandboxPath(host.temporaryDirectory)
		if (!/^[A-Za-z]:[\\/]/.test(temporaryDirectory)) throw new Error("Windows preset temporary storage must be drive-absolute")
		return { ...profile, temporaryDirectory }
	}
	return profile
}
export function validateSandboxSettings(value: unknown): SandboxSettings {
	const settings = object(value, Object.keys(DEFAULT_SANDBOX_SETTINGS))
	if (typeof settings.enabled !== "boolean" || typeof settings.allowUnsandboxedFallback !== "boolean") throw new Error("Sandbox enabled and allowUnsandboxedFallback must be explicit booleans")
	// The only migration: Phase2 persisted settings omitted the custom profile catalog.
	const catalog = settings.profiles === undefined ? [] : settings.profiles
	if (!Array.isArray(catalog)) throw new Error("Sandbox profiles must be an array")
	const profiles = catalog.map(validateCustomSandboxProfile)
	if (new Set(profiles.map((p) => p.id)).size !== profiles.length || new Set(profiles.map((p) => p.name.toLowerCase())).size !== profiles.length) throw new Error("Sandbox profile ids and names must be unique")
	const result = { enabled: settings.enabled, allowUnsandboxedFallback: settings.allowUnsandboxedFallback, mainAgentProfileId: text(settings.mainAgentProfileId, "main profile id"), subagentProfileId: text(settings.subagentProfileId, "subagent profile id"), profiles }
	resolveSandboxProfile(result, result.mainAgentProfileId)
	resolveSandboxProfile(result, result.subagentProfileId)
	return result
}

/** Trusted persistence boundary owns revisions; callers cannot forge or suppress an edit. */
export function prepareSandboxSettingsUpdate(current: unknown, next: unknown): SandboxSettings {
	const validated = validateSandboxSettings(next)
	let previous: CustomSandboxProfile[] = []
	try { previous = validateSandboxSettings(current).profiles } catch { /* Explicit valid saves repair corrupt persisted settings. */ }
	validated.profiles = validated.profiles.map((profile) => {
		const old = previous.find((entry) => entry.id === profile.id)
		if (!old && SANDBOX_BUILTIN_PROFILE_IDS.some((id) => id === profile.id)) throw new Error("Reserved sandbox profile id")
		const unchanged = old && JSON.stringify({ ...profile, revision: 0 }) === JSON.stringify({ ...old, revision: 0 })
		const revision = old ? old.revision + (unchanged ? 0 : 1) : 1
		if (!Number.isSafeInteger(revision)) throw new Error("Sandbox profile revision exhausted")
		return { ...profile, revision }
	})
	return validated
}

/** Host discovery and configured execution path, not a claim about a running command. */
export interface SandboxStatus {
	hostPlatform: string
	available: boolean
	backend?: string
	requestedEnabled?: boolean
	effectiveState: "off" | "native" | "fallback" | "blocked" | "configuration-error"
	allowUnsandboxedFallback?: boolean
	error?: string
	errorCategory?: string
	remediation?: string
	limitations: string[]
}
