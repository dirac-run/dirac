import type { ChildProcess } from "node:child_process"
import type { CustomSandboxProfile } from "@shared/SandboxSettings"

export type NativeSandboxBackend = "bubblewrap" | "seatbelt" | "windows-mxc"
export type NativeSandboxPolicy = { readonly id: "default" } | CustomSandboxProfile

export interface NativeSandboxRequest {
	executable: string
	args: readonly string[]
	cwd: string
	env: NodeJS.ProcessEnv
	policy: NativeSandboxPolicy
	context?: {
		workspaceRoots: readonly string[]
		protectedPaths: readonly string[]
		pathIdentities?: readonly { path: string; canonical: string }[]
	}
}

export type NativeSandboxErrorCategory =
	| "unsupported-host"
	| "missing-helper"
	| "unsupported-version"
	| "setup-failed"
	| "invalid-policy"
	| "launch-failed"
	| "cleanup-failed"

export class NativeSandboxError extends Error {
	constructor(
		message: string,
		readonly category: NativeSandboxErrorCategory,
		readonly stage: "before-launch" | "execution-uncertain",
		readonly fallbackEligible = false,
	) {
		super(message)
		this.name = "NativeSandboxError"
	}
}

export interface AvailableNativeSandbox {
	readonly available: true
	readonly backend: NativeSandboxBackend
	readonly helperPath: string
	readonly helperVersion?: string
	readonly limitations: readonly string[]
	readonly policyCapabilities?: {
		readonly restrictiveProfiles: boolean
		readonly taskPolicies: boolean
		readonly unsupportedControls: readonly string[]
	}
}

export type NativeSandboxCapability = AvailableNativeSandbox | { readonly available: false; readonly error: NativeSandboxError }

/** Backend-local resources; the common launcher supplies single-use and child-ownership checks. */
export interface NativeSandboxBackendLaunch {
	spawn(): ChildProcess
	dispose(): void
	terminate(child: ChildProcess): Promise<void>
}

/** Preparation is asynchronous; spawn must immediately follow the caller's final authority check. */
export interface PreparedSandboxLaunch {
	readonly backend: NativeSandboxBackend
	readonly policy: NativeSandboxPolicy
	spawn(): ChildProcess
	/** Release preparation handles when authority/cancellation prevents spawn. Idempotent. */
	dispose(): void
	/** Attempts owned cleanup; rejects when descendant cleanup cannot be established. */
	terminate(child: ChildProcess): Promise<void>
}
