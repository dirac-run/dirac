import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { type CustomSandboxProfile, validateCustomSandboxProfile } from "@shared/SandboxSettings"
import { LINUX_X64_SECCOMP_BASE64 } from "./linuxSeccomp.generated"
import { NativeSandboxError, type NativeSandboxRequest } from "./types"

import { LINUX_SELECTED_READABLE_BASELINE } from "./platformPolicy"
export { LINUX_SELECTED_READABLE_BASELINE } from "./platformPolicy"
const reserved = ["/proc", "/dev", "/sys"]
const contains = (parent: string, child: string) => parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`)
const invalid = (message: string): never => {
	throw new NativeSandboxError(message, "invalid-policy", "before-launch")
}
function absolute(value: string): string {
	const expanded = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value
	if (!path.isAbsolute(expanded) || expanded.includes("\0")) return invalid("Sandbox paths must be absolute or ~/ paths.")
	return path.normalize(expanded)
}
function canonical(value: string): string {
	try {
		return realpathSync(absolute(value))
	} catch {
		return invalid("Sandbox rule source must exist and be accessible.")
	}
}

export interface LinuxPolicyLaunch {
	args: Buffer
	filter: Buffer
	fds: number[]
	dispose(): void
}

/** Existing sources only; blocks/protected masks are always last and cannot be reopened. */
export function prepareLinuxPolicy(request: NativeSandboxRequest, profile: CustomSandboxProfile): LinuxPolicyLaunch {
	if (process.platform !== "linux" || process.arch !== "x64") return invalid("Custom native policies require Linux x86-64.")
	try {
		profile = validateCustomSandboxProfile(profile)
	} catch {
		return invalid("Invalid custom sandbox policy.")
	}
	const context = request.context
	if (!context?.protectedPaths.length) return invalid("Custom sandbox requires trusted configuration protection paths.")
	const canonicalPinned = (value: string) => {
		const source = canonical(value)
		if (context.pathIdentities) {
			const expected = context.pathIdentities.find((identity) => identity.path === value)
			if (!expected || expected.canonical !== source) return invalid("Task sandbox source identity changed during native preparation.")
		}
		return source
	}
	const protectedPaths = context.protectedPaths.map(canonical)
	const blocked = profile.filesystem.blocked.map(canonicalPinned)
	const temp = canonicalPinned(profile.temporaryDirectory)
	if (!statSync(temp).isDirectory() || reserved.some((p) => contains(p, temp) || contains(temp, p)))
		return invalid("Invalid private temporary directory.")
	const grants = new Map<string, boolean>()
	const aliases = new Map<string, string>()
	const add = (value: string, writable: boolean, baseline = false) => {
		const source = canonicalPinned(value)
		if (contains(temp, source) || contains(source, temp))
			return invalid("Filesystem grant overlaps private temporary storage; choose a separate temporaryDirectory.")
		if (reserved.some((p) => contains(p, source) || contains(source, p)))
			return invalid("Filesystem grant overlaps a reserved native path.")
		if (blocked.some((p) => contains(p, source))) return invalid("Filesystem grant is inside a blocked path.")
		if (writable && protectedPaths.some((p) => contains(source, p) || contains(p, source)))
			return invalid("Writable grant overlaps trusted configuration authority.")
		if (!baseline && grants.has(source) && grants.get(source) !== writable)
			return invalid("Conflicting canonical filesystem grants.")
		grants.set(source, writable)
		const original = absolute(value)
		if (original !== source) aliases.set(original, source)
	}
	if (profile.filesystem.base === "selected") {
		for (const value of LINUX_SELECTED_READABLE_BASELINE) {
			try {
				statSync(value)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
				throw error
			}
			add(value, false, true)
		}
	}
	for (const root of context.workspaceRoots) add(root, profile.filesystem.workspace === "read-write")
	for (const value of profile.filesystem.readable) add(value, false)
	for (const value of [...profile.filesystem.writable, ...profile.filesystem.caches]) add(value, true)
	if ([...blocked, ...protectedPaths].some((p) => reserved.some((r) => contains(p, r)) || contains(p, temp))) {
		return invalid("Blocked/protected paths cannot mask native runtime roots or private temp.")
	}
	const argv = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--disable-userns",
		"--assert-userns-disabled",
		"--cap-drop",
		"ALL",
		"--die-with-parent",
		"--new-session",
		"--seccomp",
		"3",
		"--clearenv",
	]
	if (profile.network === "deny") argv.push("--unshare-net")
	const env: NodeJS.ProcessEnv = {}
	for (const name of profile.environment.passthrough) if (request.env[name] !== undefined) env[name] = request.env[name]
	Object.assign(env, profile.environment.overrides, { TMPDIR: temp, TMP: temp, TEMP: temp })
	for (const [name, value] of Object.entries(env)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value?.includes("\0")) return invalid("Invalid workload environment entry.")
		argv.push("--setenv", name, value!)
	}
	const fds: number[] = []
	const dispose = () => {
		for (const fd of fds.splice(0)) closeSync(fd)
	}
	const bind = (source: string, destination: string, writable: boolean) => {
		// Linux O_PATH pins mount sources without opening file contents/devices.
		const fd = openSync(source, 0x200000 | constants.O_NOFOLLOW)
		fds.push(fd)
		if (fstatSync(fd).isSymbolicLink() || realpathSync(`/proc/self/fd/${fd}`) !== source)
			return invalid("Sandbox source identity changed during preparation.")
		argv.push(writable ? "--bind-fd" : "--ro-bind-fd", String(4 + fds.length), destination)
	}
	try {
		if (profile.filesystem.base === "broad-read") bind("/", "/", false)
		for (const [source, writable] of [...grants].sort(([a], [b]) => a.split("/").length - b.split("/").length))
			bind(source, source, writable)
		if (profile.filesystem.base === "selected") {
			for (const [alias, source] of aliases) {
				if (![...grants.keys()].some((parent) => contains(parent, alias))) argv.push("--symlink", source, alias)
			}
		}
		argv.push("--tmpfs", temp)
		argv.push("--proc", "/proc", "--dev", "/dev", "--perms", "000", "--tmpfs", "/sys", "--remount-ro", "/sys")
		for (const source of [...new Set([...blocked, ...protectedPaths])].sort((a, b) => b.length - a.length)) {
			if (statSync(source).isDirectory()) argv.push("--perms", "000", "--tmpfs", source, "--remount-ro", source)
			else bind("/dev/null", source, false)
		}
		argv.push("--chdir", canonical(request.cwd))
		if (argv.some((value) => value.includes("\0"))) return invalid("Native arguments cannot contain NUL bytes.")
		return {
			args: Buffer.from(`${argv.join("\0")}\0`),
			filter: Buffer.from(LINUX_X64_SECCOMP_BASE64, "base64"),
			fds,
			dispose,
		}
	} catch (error) {
		dispose()
		if (error instanceof NativeSandboxError) throw error
		return invalid("Cannot prepare native filesystem handles; no workload launched.")
	}
}
