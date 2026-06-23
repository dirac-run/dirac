import { HookRegistry } from "./HookRegistry"
import type { Hooks } from "./hook-factory"

type HookName = keyof Hooks

/**
 * Builds hook execution configuration by determining source attribution and
 * working directory for each discovered hook script.
 *
 * - Global hooks (~/Documents/Dirac/Hooks/) run from the primary workspace root
 * - Workspace hooks (.diracrules/hooks/) run from their respective workspace root
 */
export class HookConfigBuilder {
	/** Determines if a single script is from global or workspace location. */
	static determineScriptSource(scriptPath: string, hooksDirs: string[]): "global" | "workspace" {
		const containingDir = hooksDirs.find((dir) => scriptPath.startsWith(dir))
		if (containingDir && HookRegistry.isGlobalHooksDir(containingDir)) return "global"
		return "workspace" // Default to workspace if uncertain
	}

	/** Determines the working directory for a hook script based on its location. */
	static determineHookCwd(
		scriptPath: string,
		hooksDirs: string[],
		workspaceRoots: Array<{ path: string }> | undefined,
		primaryCwd: string | undefined,
	): string | undefined {
		const containingDir = hooksDirs.find((dir) => scriptPath.startsWith(dir))

		// Global hooks run from primary workspace root
		if (containingDir && HookRegistry.isGlobalHooksDir(containingDir)) return primaryCwd

		// Workspace hooks run from their containing workspace root
		if (containingDir && workspaceRoots) {
			const workspaceRoot = workspaceRoots.find((root) => containingDir.startsWith(root.path))
			if (workspaceRoot) return workspaceRoot.path
		}

		return primaryCwd // Fallback to primary cwd
	}

	/** Categorizes hook scripts by location (global vs workspace) for telemetry. */
	static categorizeHookScripts(scripts: string[], hooksDirs: string[]): { globalCount: number; workspaceCount: number } {
		if (scripts.length === 0) return { globalCount: 0, workspaceCount: 0 }

		let globalCount = 0
		let workspaceCount = 0
		for (const script of scripts) {
			const containingDir = hooksDirs.find((dir) => script.startsWith(dir))
			if (containingDir && HookRegistry.isGlobalHooksDir(containingDir)) globalCount++
			else workspaceCount++
		}
		return { globalCount, workspaceCount }
	}
}
