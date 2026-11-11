import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { type CustomSandboxProfile, validateCustomSandboxProfile } from "@shared/SandboxSettings"
import { macOSEnvironmentPayload } from "./macosEnvironment"
import { canonicalSandboxPath, MACOS_SELECTED_READABLE_BASELINE, sandboxPathContains } from "./platformPolicy"
import { NativeSandboxError, type NativeSandboxRequest } from "./types"

export { MACOS_SELECTED_READABLE_BASELINE } from "./platformPolicy"

const invalid = (message: string): never => {
	throw new NativeSandboxError(message, "invalid-policy", "before-launch")
}
const contains = (parent: string, child: string) => sandboxPathContains(parent, child, "darwin")
const expanded = (value: string) =>
	path.posix.normalize(value.startsWith("~/") ? path.posix.join(homedir(), value.slice(2)) : value)

function assertWritableRoot(value: string): void {
	const original = expanded(value)
	if (original === "/") invalid("Writable filesystem-root grants are unsupported.")
	let current = "/"
	for (const component of original.split("/").filter(Boolean)) {
		current = path.posix.join(current, component)
		if (!lstatSync(current).isSymbolicLink()) continue
		const trustedAlias =
			(current === "/tmp" && realpathSync(current) === "/private/tmp") ||
			(current === "/var" && realpathSync(current) === "/private/var")
		if (!trustedAlias) invalid("Writable roots cannot contain mutable symlink components.")
	}
}

/** SBPL strings, never regexes or interpolated source fragments. Paths use named parameters. */
export function seatbeltString(value: string): string {
	if (/[\x00-\x1f\x7f]/.test(value)) return invalid("Seatbelt values cannot contain control characters.")
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export interface MacOSPolicyLaunch {
	readonly policy: string
	readonly parameters: readonly string[]
	readonly env: NodeJS.ProcessEnv
	readonly environmentPayload: Buffer
	readonly temporaryDirectory: string
	revalidate(): void
	dispose(): void
}

/** Pure compiler. Positive rules explicitly exclude authority/blocks and deeper RO exceptions. */
export function compileSeatbeltPolicy(input: {
	readable: readonly string[]
	writable: readonly string[]
	blocked: readonly string[]
	protected: readonly string[]
	network: "allow" | "deny"
	/** Omitted only in pure callers whose rules all describe directories. */
	directoryPaths?: readonly string[]
}): { policy: string; parameters: string[] } {
	const parameters: string[] = []
	const names = new Map<string, string>()
	const parameter = (value: string) => {
		seatbeltString(value)
		let name = names.get(value)
		if (!name) {
			name = `DIRAC_PATH_${names.size}`
			names.set(value, name)
			parameters.push("-D", `${name}=${value}`)
		}
		return `(param "${name}")`
	}
	const literal = (value: string) => `(literal ${parameter(value)})`
	// subpath alone does NOT exclude creation/replacement of the root itself.
	const subtree = (value: string) => `(require-any ${literal(value)} (subpath ${parameter(value)}))`
	const grant = (value: string) =>
		!input.directoryPaths || input.directoryPaths.includes(value) ? subtree(value) : literal(value)
	const forbidden = [...new Set([...input.blocked, ...input.protected])]
	const readable = [...new Set([...input.readable, ...input.writable])]
	const lines = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow signal (target self))",
		"(allow sysctl-read)",
	]
	for (const value of readable) {
		const exclusions = forbidden.map((p) => `(require-not ${subtree(p)})`)
		lines.push(`(allow file-read* file-map-executable (require-all ${grant(value)} ${exclusions.join(" ")}))`)
	}
	for (const value of input.writable) {
		const ro = input.readable.filter((p) => p !== value && contains(value, p))
		const exclusions = [...forbidden, ...ro].map((p) => `(require-not ${subtree(p)})`)
		lines.push(`(allow file-write* (require-all ${grant(value)} ${exclusions.join(" ")}))`)
	}
	lines.push("(allow file-read-metadata)")
	lines.push('(allow file-read* file-write-data (literal "/dev/null") (literal "/dev/zero"))')
	lines.push('(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))')
	if (input.network === "allow")
		lines.push(
			'(allow network-bind (local ip "*:*"))',
			'(allow network-inbound (local ip "*:*"))',
			'(allow network-outbound (remote ip "*:*"))',
		)
	// Explicit final IPC deny: no implicit service authority from filesystem/network grants.
	lines.push('(deny mach-lookup (xpc-service-name-prefix ""))')
	lines.push("(deny file-link)")
	// Final masks must follow even fixed device/runtime grants; blocks always win.
	for (const value of forbidden) lines.push(`(deny file-read* file-write* file-map-executable ${subtree(value)})`)
	const guarded = new Set<string>()
	for (const value of [...forbidden, ...input.readable, ...input.writable]) {
		let ancestor =
			input.writable.includes(value) && input.directoryPaths && !input.directoryPaths.includes(value)
				? path.posix.dirname(value)
				: value
		while (ancestor !== "/") {
			guarded.add(ancestor)
			ancestor = path.posix.dirname(ancestor)
		}
	}
	for (const value of guarded) lines.push(`(deny file-write-unlink ${literal(value)})`)
	return { policy: `${lines.join("\n")}\n`, parameters }
}

export function prepareMacOSPolicy(request: NativeSandboxRequest, original: CustomSandboxProfile): MacOSPolicyLaunch {
	let profile: CustomSandboxProfile
	try {
		profile = validateCustomSandboxProfile(original)
	} catch {
		return invalid("Invalid custom sandbox policy.")
	}
	const context = request.context
	if (!context?.protectedPaths.length) return invalid("Custom sandbox requires trusted configuration protection paths.")
	const identities = new Map<string, { canonical: string; dev: number; ino: number }>()
	const canonical = (value: string) => {
		let result: string
		try {
			result = canonicalSandboxPath(value)
		} catch {
			return invalid("Sandbox rule source must exist and be accessible.")
		}
		const expected = context.pathIdentities?.find((entry) => entry.path === value)
		if (context.pathIdentities && (!expected || expected.canonical !== result))
			return invalid("Sandbox path identity changed during preparation.")
		const stat = statSync(result)
		identities.set(value, { canonical: result, dev: stat.dev, ino: stat.ino })
		return result
	}
	// Protected paths are trusted authority, not task-local grant identities.
	const protectedPaths = context.protectedPaths.map((value) => {
		const source = realpathSync(value)
		const stat = statSync(source)
		identities.set(value, { canonical: source, dev: stat.dev, ino: stat.ino })
		return source
	})
	const blocked = profile.filesystem.blocked.map(canonical)
	const grants = new Map<string, boolean>()
	const add = (value: string, writable: boolean, baseline = false) => {
		if (writable) assertWritableRoot(value)
		const source = canonical(value)
		if (blocked.some((p) => contains(p, source))) return invalid("Filesystem grant is inside a blocked path.")
		if (writable && protectedPaths.some((p) => contains(p, source)))
			return invalid("Writable grant is inside trusted configuration authority.")
		if (!baseline && grants.has(source) && grants.get(source) !== writable)
			return invalid("Conflicting canonical filesystem grants.")
		grants.set(source, writable)
	}
	if (profile.filesystem.base === "broad-read") grants.set("/", false)
	else
		for (const value of MACOS_SELECTED_READABLE_BASELINE) {
			try {
				statSync(value)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
				throw error
			}
			add(value, false, true)
		}
	for (const root of context.workspaceRoots) add(root, profile.filesystem.workspace === "read-write")
	for (const value of profile.filesystem.readable) add(value, false)
	for (const value of [...profile.filesystem.writable, ...profile.filesystem.caches]) add(value, true)
	const parent = canonical(profile.temporaryDirectory)
	if (!statSync(parent).isDirectory() || [...blocked, ...protectedPaths].some((p) => contains(p, parent)))
		return invalid("Invalid temporary directory parent.")
	const writable = [...grants].filter(([, write]) => write).map(([source]) => source)
	const readable = [...grants].filter(([, write]) => !write).map(([source]) => source)
	const prohibited = [...blocked, ...protectedPaths, ...readable.filter((p) => writable.some((w) => contains(w, p)))]
	const inspectWritable = (source: string) => {
		const stat = lstatSync(source)
		if (stat.isSymbolicLink()) {
			const target = realpathSync(source)
			if (!writable.some((p) => contains(p, target)) || prohibited.some((p) => contains(p, target)))
				return invalid("Writable trees cannot contain symlinks outside writable authority.")
			return
		}
		if (!stat.isDirectory()) return
		for (const name of readdirSync(source)) inspectWritable(path.join(source, name))
	}
	for (const source of writable) inspectWritable(source)
	const temporaryDirectory = mkdtempSync(path.join(parent, "dirac-execution-"))
	let disposed = false
	const dispose = () => {
		if (!disposed) {
			rmSync(temporaryDirectory, { recursive: true, force: true })
			disposed = true
		}
	}
	try {
		const env: NodeJS.ProcessEnv = {}
		for (const name of profile.environment.passthrough) if (request.env[name] !== undefined) env[name] = request.env[name]
		Object.assign(env, profile.environment.overrides, {
			TMPDIR: temporaryDirectory,
			TMP: temporaryDirectory,
			TEMP: temporaryDirectory,
		})
		// sandbox-exec loads in the trusted host before applying Seatbelt. No loader/bootstrap injection.
		for (const [name, value] of Object.entries(env)) {
			if (/^(DYLD_|LD_)/.test(name))
				return invalid("macOS restrictive policies do not support dynamic-loader environment variables.")
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value?.includes("\0"))
				return invalid("Invalid workload environment entry.")
		}
		const compiled = compileSeatbeltPolicy({
			readable,
			writable: [...writable, temporaryDirectory],
			blocked: [...blocked, ...profile.filesystem.blocked.map(expanded)],
			protected: [...protectedPaths, ...context.protectedPaths.map(expanded)],
			network: profile.network,
			directoryPaths: [...grants.keys(), temporaryDirectory].filter((source) => statSync(source).isDirectory()),
		})
		return {
			...compiled,
			env,
			environmentPayload: macOSEnvironmentPayload(env),
			temporaryDirectory,
			dispose,
			revalidate() {
				for (const [value, identity] of identities) {
					const source = realpathSync(value.startsWith("~/") ? canonicalSandboxPath(value) : value)
					const stat = statSync(source)
					if (source !== identity.canonical || stat.dev !== identity.dev || stat.ino !== identity.ino)
						return invalid("Sandbox source was replaced after preparation.")
				}
			},
		}
	} catch (error) {
		dispose()
		throw error
	}
}
