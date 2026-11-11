import type { NativeSandboxRequest } from "./types"
import { NativeSandboxError } from "./types"

export const WINDOWS_MXC_PROTOCOL = 1
export const WINDOWS_MXC_REVISION = "fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2"
export const WINDOWS_MXC_HELPER_VERSION = "1.0.0"

export interface WindowsMxcLaunch {
	protocol: 1
	executable: string
	args: string[]
	cwd: string
	environment: Record<string, string>
	readonlyPaths: string[]
	readwritePaths: string[]
	deniedPaths: string[]
	network: "allow" | "deny"
}

function invalid(message: string): never {
	throw new NativeSandboxError(message, "invalid-policy", "before-launch")
}

/** No UNC, device names, ADS, DOS aliases, root grants, or normalization guesses. */
export function windowsPolicyPath(path: string): string {
	if (!/^[a-zA-Z]:[\\/]/.test(path) || /[^\x20-\x7e]|[<>"|?*~]/.test(path))
		invalid("MXC requires ASCII drive-absolute paths without aliases or wildcards.")
	const normalized = path.replaceAll("/", "\\")
	const parts = normalized.slice(3).split("\\")
	if (
		!parts.length ||
		parts.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				/[ .:]$|:/.test(part) ||
				/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
		)
	) {
		invalid("MXC cannot represent root, ambiguous, device, or alternate-stream paths.")
	}
	return normalized
}

export function windowsPathContains(parent: string, child: string): boolean {
	const a = parent.toLowerCase(),
		b = child.toLowerCase()
	return a === b || b.startsWith(`${a}\\`)
}

/** Explicit runtime baseline, never a copy of the user's entire environment. */
export function windowsRuntimeEnvironment(host: NodeJS.ProcessEnv): Record<string, string> {
	const values = new Map<string, string>()
	for (const [key, value] of Object.entries(host)) {
		if (value === undefined) continue
		const canonical = key.toUpperCase()
		if (values.has(canonical)) invalid("Windows host environment contains case-insensitive duplicate keys.")
		values.set(canonical, value)
	}
	const result: Record<string, string> = {}
	for (const key of ["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "LOCALAPPDATA", "COMSPEC", "PATHEXT"]) {
		const value = values.get(key)
		if (value !== undefined) result[key] = value
	}
	if (!result.SYSTEMROOT || !result.SYSTEMDRIVE || !result.LOCALAPPDATA)
		invalid("Windows runtime baseline requires trusted SYSTEMROOT, SYSTEMDRIVE and LOCALAPPDATA.")
	result.WINDIR = result.SYSTEMROOT
	result.PATH = `${result.SYSTEMROOT}\\System32;${result.SYSTEMROOT}`
	return result
}

export function windowsReadableBaseline(host: NodeJS.ProcessEnv): string[] {
	const env = Object.fromEntries(Object.entries(host).map(([key, value]) => [key.toUpperCase(), value]))
	return [
		...new Set(
			[env.SYSTEMROOT, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]
				.filter((value): value is string => !!value)
				.map(windowsPolicyPath),
		),
	]
}

export function translateWindowsPolicy(
	request: NativeSandboxRequest,
	temporaryDirectory: string,
	host: NodeJS.ProcessEnv,
	internalProtectedPaths: readonly string[] = [],
): WindowsMxcLaunch {
	const policy = request.policy
	if (!("kind" in policy) || policy.filesystem.base !== "selected")
		invalid(
			"Native MXC currently supports selected-location profiles only; Default and broad-read/root mappings cannot be represented faithfully.",
		)
	if (!request.context?.workspaceRoots.length || !request.context.protectedPaths.length)
		invalid("MXC requires trusted workspace and protected configuration paths.")
	const cwd = windowsPolicyPath(request.cwd)
	const executable = windowsPolicyPath(request.executable)
	const read = [...windowsReadableBaseline(host), ...policy.filesystem.readable].map(windowsPolicyPath)
	const write = [...policy.filesystem.writable, ...policy.filesystem.caches, temporaryDirectory].map(windowsPolicyPath)
	const workspace = request.context.workspaceRoots.map(windowsPolicyPath)
	;(policy.filesystem.workspace === "read-write" ? write : read).push(...workspace)
	const deny = [...policy.filesystem.blocked, ...request.context.protectedPaths, ...internalProtectedPaths].map(
		windowsPolicyPath,
	)
	const temporaryParent = windowsPolicyPath(policy.temporaryDirectory)
	for (const path of [...read, ...write.filter((path) => path !== temporaryDirectory), ...deny]) {
		if (windowsPathContains(path, temporaryParent) || windowsPathContains(temporaryParent, path))
			invalid(
				"MXC temporary storage must not overlap workspace, runtime, grants, or protected paths; sibling executions must remain private.",
			)
	}
	// PSEC deny wins. A read-only carveout inside writable ancestry cannot be
	// expressed as deny-write without also denying reads; reject, don't flatten.
	for (const readonly of read) {
		if (write.some((writable) => windowsPathContains(writable, readonly)))
			invalid("MXC cannot represent a read-only grant nested inside writable access.")
	}
	for (const grant of [...read, ...write]) {
		if (deny.some((blocked) => windowsPathContains(blocked, grant)))
			invalid("MXC grant conflicts with a blocked or protected configuration path.")
	}
	if (deny.some((blocked) => windowsPathContains(blocked, cwd) || windowsPathContains(blocked, executable)))
		invalid("MXC executable or working directory is blocked.")
	if (![...read, ...write].some((grant) => windowsPathContains(grant, cwd)))
		invalid("MXC working directory is outside the filesystem grants.")
	const hostEntries = new Map<string, string>()
	for (const [key, value] of Object.entries(request.env)) {
		if (value === undefined) continue
		const upper = key.toUpperCase()
		if (hostEntries.has(upper)) invalid("Windows workload environment contains case-insensitive duplicate keys.")
		hostEntries.set(upper, value)
	}
	const environment = windowsRuntimeEnvironment(host)
	const selected = new Set<string>()
	for (const key of policy.environment.passthrough) {
		const upper = key.toUpperCase()
		if (selected.has(upper)) invalid("Windows environment passthrough contains case-insensitive duplicates.")
		selected.add(upper)
		const value = hostEntries.get(upper)
		if (value !== undefined) environment[upper] = value
	}
	const overridden = new Set<string>()
	for (const [key, value] of Object.entries(policy.environment.overrides)) {
		const upper = key.toUpperCase()
		if (overridden.has(upper)) invalid("Windows environment overrides contain case-insensitive duplicates.")
		overridden.add(upper)
		if (["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR"].includes(upper))
			invalid("Windows runtime and per-execution temporary environment keys cannot be overridden.")
		environment[upper] = value
	}
	for (const [key, value] of Object.entries(environment)) {
		if (!/^[A-Z_][A-Z0-9_()]*$/.test(key) || /[\x00]/.test(value)) invalid("Invalid Windows environment entry.")
	}
	// Restore trusted baseline even if passthrough requested alternate spellings.
	Object.assign(
		environment,
		Object.fromEntries(
			Object.entries(windowsRuntimeEnvironment(host)).filter(([key]) =>
				["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "LOCALAPPDATA"].includes(key),
			),
		),
	)
	environment.TEMP = windowsPolicyPath(temporaryDirectory)
	environment.TMP = environment.TEMP
	environment.TMPDIR = environment.TEMP
	const unique = (paths: string[]) => [...new Map(paths.map((path) => [path.toLowerCase(), path])).values()]
	return {
		protocol: WINDOWS_MXC_PROTOCOL,
		executable,
		args: [...request.args],
		cwd,
		environment,
		readonlyPaths: unique(read),
		readwritePaths: unique(write),
		deniedPaths: unique(deny),
		network: policy.network,
	}
}

export function windowsTemporaryParent(request: NativeSandboxRequest): string {
	if (!("kind" in request.policy)) invalid("Default has no representable MXC temporary policy.")
	return windowsPolicyPath(request.policy.temporaryDirectory)
}
