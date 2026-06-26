import { resolveWindowsPowerShellExecutable } from "@/utils/powershell"
import { escapeShellPath } from "./shell-escape"

export interface HookLaunchConfig {
	command: string
	args: string[]
	shell: boolean
	detached: boolean
}

const WINDOWS_HOOK_LAUNCHER_CACHE_TTL_MS = 5 * 60 * 1000

let resolvedHookLauncherCommandPromise: Promise<string> | null = null
let resolvedHookLauncherCommandExpiresAt = 0

export function resetHookLaunchConfigCacheForTesting(): void {
	resolvedHookLauncherCommandPromise = null
	resolvedHookLauncherCommandExpiresAt = 0
}

function shouldRefreshWindowsLauncherCache(now: number): boolean {
	return !resolvedHookLauncherCommandPromise || now >= resolvedHookLauncherCommandExpiresAt
}

/**
 * Returns the process launch configuration for a hook script.
 *
 * On Windows, the PowerShell executable lookup is cached briefly so concurrent
 * hook launches share the same in-flight resolution and avoid repeated process
 * spawning.
 *
 * @param scriptPath Path to the hook script to launch.
 * @param resolvePowerShellExecutable Windows only. Called at most once per
 *   `WINDOWS_HOOK_LAUNCHER_CACHE_TTL_MS` window; subsequent concurrent or cached
 *   calls reuse the shared result and ignore this parameter.
 */
export async function getHookLaunchConfig(
	scriptPath: string,
	resolvePowerShellExecutable: () => Promise<string> = resolveWindowsPowerShellExecutable,
): Promise<HookLaunchConfig> {
	if (process.platform === "win32") {
		return getWindowsHookLaunchConfig(scriptPath, resolvePowerShellExecutable)
	}

	const escapedScriptPath = escapeShellPath(scriptPath)
	return { command: escapedScriptPath, args: [], shell: true, detached: true }
}

// Windows launch config with cached PowerShell executable resolution.
async function getWindowsHookLaunchConfig(
	scriptPath: string,
	resolvePowerShellExecutable: () => Promise<string>,
): Promise<HookLaunchConfig> {
	const now = Date.now()

	if (shouldRefreshWindowsLauncherCache(now)) {
		resolvedHookLauncherCommandPromise = resolvePowerShellExecutable().catch((error) => {
			resolvedHookLauncherCommandPromise = null
			resolvedHookLauncherCommandExpiresAt = 0
			throw error
		})
		resolvedHookLauncherCommandExpiresAt = now + WINDOWS_HOOK_LAUNCHER_CACHE_TTL_MS
	}

	const powerShellExecutable = await resolvedHookLauncherCommandPromise!
	return {
		command: powerShellExecutable,
		args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
		shell: false,
		detached: false,
	}
}
