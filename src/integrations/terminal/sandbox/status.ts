import { resolveSandboxProfile, type CustomSandboxProfile, type SandboxSettings, type SandboxStatus, validateSandboxSettings } from "@shared/SandboxSettings"
import { sandboxPathStyle } from "@shared/SandboxPath"
import { BUBBLEWRAP_VERSION } from "./defaultPolicy"
import { sandboxPlatformPolicy } from "./platformPolicy"
import type { NativeSandboxCapability } from "./types"

function unsupportedProfileControls(profile: CustomSandboxProfile, unsupported: readonly string[]): string[] {
	const used: Record<string, boolean> = {
		"restrictiveProfiles": true,
		"filesystem.broad-read": profile.filesystem.base === "broad-read",
		"filesystem.selected": profile.filesystem.base === "selected",
		"filesystem.blocked": profile.filesystem.blocked.length > 0,
		"filesystem.caches": profile.filesystem.caches.length > 0,
		"network.deny": profile.network === "deny",
		"network.allow": profile.network === "allow",
		"environment": true,
		"environment.dynamic-loader": [...profile.environment.passthrough, ...Object.keys(profile.environment.overrides)].some((name) => /^(DYLD_|LD_)/.test(name)),
	}
	return unsupported.filter((control) => used[control])
}

/** Pure status projection; host capability discovery is explicit and cached by the caller. */
export function buildSandboxStatus(
	value: unknown,
	capability: NativeSandboxCapability,
	hostPlatform: string,
	hostArch: string = process.arch,
): SandboxStatus {
	const status: SandboxStatus = {
		hostPlatform, available: capability.available,
		backend: capability.available ? capability.backend : undefined,
		effectiveState: "configuration-error",
		limitations: [
			"Default is permissive and provides no meaningful isolation.",
			"Only commands are covered; host file tools, custom tools and services remain trusted.",
			...(capability.available ? capability.limitations : []),
		],
	}
	let settings: SandboxSettings
	try { settings = validateSandboxSettings(value) } catch (error) {
		return {
			...status, error: (error as Error).message, errorCategory: "invalid-configuration",
			remediation: "Save valid Sandbox settings to repair the configuration. Commands are blocked until repaired."
		}
	}
	status.requestedEnabled = settings.enabled
	status.allowUnsandboxedFallback = settings.allowUnsandboxedFallback
	const assigned = [settings.mainAgentProfileId, settings.subagentProfileId]
		.map((id) => resolveSandboxProfile(settings, id)).filter((profile): profile is CustomSandboxProfile => "kind" in profile)
	const platform = sandboxPlatformPolicy(hostPlatform, hostArch)
	const controls = capability.available ? capability.policyCapabilities : undefined
	const unsupportedDefault = (controls?.unsupportedControls.includes("default") || hostPlatform === "win32") &&
		[settings.mainAgentProfileId, settings.subagentProfileId].includes("default")
	if (unsupportedDefault) return {
		...status, effectiveState: settings.enabled ? "blocked" : "off", errorCategory: "unsupported-policy",
		error: "Default's permissive filesystem policy cannot be represented by this native backend; it will not be silently restricted or replayed unsandboxed.",
		remediation: "Select a supported restrictive profile for both assignments, or explicitly disable sandboxing.",
	}
	if (assigned.length) {
		status.limitations.push(
			"Path existence, native path identity and policy conflicts are checked before launch; readiness is not a running-command protection claim.",
			"Environment overrides are plaintext trusted settings; do not store secrets in profiles.",
		)
		if (hostPlatform === "linux") status.limitations.push("Linux private temporary storage is a fresh per-launch tmpfs.")
		if (hostPlatform === "darwin" || hostPlatform === "win32")
			status.limitations.push("Private temporary storage is a unique host-backed directory, not a Linux tmpfs.")
		if (controls?.taskPolicies === false || !platform.taskPolicies)
			status.limitations.push("Task-local policy support requires separately validated host baseline and path identities; unsupported task policies fail closed.")
		const supported = controls?.restrictiveProfiles ?? (!capability.available ? platform.restrictiveProfiles : hostPlatform === "linux" && platform.restrictiveProfiles)
		const unsupported = assigned.flatMap((profile) => unsupportedProfileControls(profile,
			controls?.unsupportedControls ?? (hostPlatform === "win32" ? ["filesystem.broad-read"] : hostPlatform === "darwin" ? ["environment.dynamic-loader"] : [])))
		const incompatiblePath = assigned.some((profile) => {
			// Presets are adapted by the execution-host resolver, not by guessing the UI host's temporary path.
			const custom = settings.profiles.some((saved) => saved.id === profile.id)
			if (!custom) return false
			return [...profile.filesystem.readable, ...profile.filesystem.writable, ...profile.filesystem.blocked, ...profile.filesystem.caches, profile.temporaryDirectory]
				.some((p) => (sandboxPathStyle(p) === "windows-drive") !== (hostPlatform === "win32"))
		})
		if (!supported || unsupported.length || incompatiblePath) return {
			...status, effectiveState: settings.enabled ? "blocked" : "off", errorCategory: "unsupported-policy",
			error: `Assigned sandbox controls are unsupported on ${hostPlatform}/${hostArch}${unsupported.length ? `: ${[...new Set(unsupported)].join(", ")}` : incompatiblePath ? ": saved paths belong to another platform" : ""}. Unsandboxed fallback cannot discard unsupported controls.`,
			remediation: "Use a supported execution host and representable profile, select Default, or explicitly disable sandboxing.",
		}
	}
	status.effectiveState = !settings.enabled ? "off" : capability.available ? "native"
		: settings.allowUnsandboxedFallback && capability.error.fallbackEligible ? "fallback" : "blocked"
	if (!capability.available) {
		status.error = capability.error.message
		status.errorCategory = capability.error.category
		status.remediation = hostPlatform === "linux"
			? `Check Bubblewrap ${BUBBLEWRAP_VERSION} at /usr/bin/bwrap and host user/PID namespace support. Restart the execution host after fixing setup; discovery is cached.`
			: hostPlatform === "darwin"
				? "Check /usr/bin/sandbox-exec and OS sandbox support. Restart the execution host after fixing setup; discovery is cached."
				: hostPlatform === "win32"
					? "Check the packaged native MXC helper and Windows process-isolation prerequisites. Restart the execution host after fixing setup; discovery is cached. WSL and Windows Sandbox are not used."
					: "Native sandbox execution is not implemented on this host. Disable sandboxing or explicitly permit unsandboxed fallback."
	}
	return status
}
