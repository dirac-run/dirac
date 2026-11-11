import { lstatSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { sandboxPathStyle, validateSandboxPath } from "@shared/SandboxPath"
import type { SandboxPolicyHostIdentity } from "@shared/SandboxTaskPolicy"
import { windowsPolicyPath, windowsReadableBaseline } from "./windowsPolicy"

/** This list is shared by enforcement and task-ceiling comparison. Keep Linux semantics stable. */
export const LINUX_SELECTED_READABLE_BASELINE = Object.freeze([
	"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/hosts",
	"/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/ssl/certs", "/etc/pki",
])
export const MACOS_SELECTED_READABLE_BASELINE = Object.freeze([
	"/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/private/etc/hosts",
	"/private/etc/resolv.conf", "/private/etc/services", "/private/etc/protocols", "/private/etc/ssl/cert.pem",
])

export interface SandboxPlatformPolicy {
	identity: SandboxPolicyHostIdentity
	restrictiveProfiles: boolean
	taskPolicies: boolean
	readableBaseline: readonly string[]
	temporaryStorage: "private-tmpfs" | "private-host-directory" | "unsupported"
}

/** Static compiler support, not a substitute for probing the executing machine's native helper. */
export function sandboxPlatformPolicy(platform: string, arch: string): SandboxPlatformPolicy {
	if (platform === "linux") return {
		identity: { platform, arch, policySemantics: "linux-bwrap-selected-v1" },
		restrictiveProfiles: arch === "x64", taskPolicies: arch === "x64",
		readableBaseline: LINUX_SELECTED_READABLE_BASELINE, temporaryStorage: "private-tmpfs",
	}
	if (platform === "darwin") return {
		identity: { platform, arch, policySemantics: "darwin-seatbelt-selected-v1" },
		restrictiveProfiles: arch === "x64" || arch === "arm64", taskPolicies: false,
		readableBaseline: MACOS_SELECTED_READABLE_BASELINE, temporaryStorage: "private-host-directory",
	}
	if (platform === "win32") return {
		identity: { platform, arch, policySemantics: "win32-mxc-drive-v1" },
		restrictiveProfiles: arch === "x64" || arch === "arm64", taskPolicies: arch === "x64" || arch === "arm64",
		readableBaseline: platform === process.platform ? windowsReadableBaseline(process.env) : [], temporaryStorage: "private-host-directory",
	}
	return {
		identity: { platform, arch, policySemantics: "unsupported" },
		restrictiveProfiles: false, taskPolicies: false, readableBaseline: [], temporaryStorage: "unsupported",
	}
}

/** Windows canonical identity needs native reparse/volume validation, never Node realpath alone. */
export function canonicalSandboxPath(value: string, platform: string = process.platform): string {
	validateSandboxPath(value)
	if (platform === "win32") {
		if (process.platform !== "win32") throw new Error("Windows sandbox canonical identity requires its native execution host")
		const normalized = windowsPolicyPath(value)
		const root = path.win32.parse(normalized).root
		let component = root
		for (const part of normalized.slice(root.length).split("\\")) {
			component = path.win32.join(component, part)
			if (lstatSync(component).isSymbolicLink()) throw new Error("Windows sandbox paths cannot traverse reparse aliases")
		}
		const actual = realpathSync.native(normalized)
		if (actual.toLowerCase() !== normalized.toLowerCase()) throw new Error("Windows sandbox path canonical identity changed")
		// Native preparation additionally rejects ALL reparse tags and case-sensitive directories,
		// pins components against rename, and rechecks saved identities before any child can execute.
		return normalized.toLowerCase()
	}
	if (platform !== "linux" && platform !== "darwin")
		throw new Error("Sandbox canonical paths require a validated native host path resolver")
	if (sandboxPathStyle(value) !== "posix") throw new Error("Sandbox path does not belong to this execution host")
	const expanded = value.startsWith("~/") ? path.posix.join(homedir(), value.slice(2)) : value
	return realpathSync(expanded)
}

/** Canonical POSIX spelling is case-exact; macOS volume case/alias safety is NOT inferred. */
export function sandboxPathContains(parent: string, child: string, platform: string = process.platform): boolean {
	if (platform === "win32") {
		validateSandboxPath(parent)
		validateSandboxPath(child)
		if (sandboxPathStyle(parent) !== "windows-drive" || sandboxPathStyle(child) !== "windows-drive")
			throw new Error("Windows sandbox containment requires drive-absolute paths")
		const normalize = (p: string) => path.win32.normalize(p).replace(/[\\]+$/, "").toLowerCase()
		const a = normalize(parent), b = normalize(child)
		return a === b || b.startsWith(`${a}\\`)
	}
	return parent === child || child.startsWith(parent === "/" ? "/" : `${parent}/`)
}

export function existingSandboxBaseline(policy: SandboxPlatformPolicy): string[] {
	return policy.readableBaseline.filter((value) => {
		try { statSync(value); return true } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
			throw error
		}
	})
}

export function requireSandboxTaskHost(platform: string = process.platform, arch: string = process.arch): SandboxPlatformPolicy {
	const policy = sandboxPlatformPolicy(platform, arch)
	if (!policy.taskPolicies)
		throw new Error(`Explicit task sandbox policy is unsupported on ${platform}/${arch}: native baseline and path identity semantics are not validated; unrestricted fallback is forbidden`)
	return policy
}
