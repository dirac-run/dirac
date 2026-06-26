import fs from "fs/promises"
import path from "path"
import { getAllHooksDirs } from "../storage/disk"
import type { Hooks } from "./hook-factory"

type HookName = keyof Hooks

/**
 * Checks if an error encountered during hook discovery is expected and can be safely ignored.
 * Expected errors include file not found, permission denied, and invalid path components.
 */
function isExpectedHookError(error: unknown): boolean {
	if (!(error instanceof Error)) return false

	const nodeError = error as NodeJS.ErrnoException
	// Expected: File doesn't exist, permission denied, or not a directory
	return nodeError.code === "ENOENT" || nodeError.code === "EACCES" || nodeError.code === "ENOTDIR"
}

/**
 * Registry for hook script discovery and lookup.
 *
 * Responsible for finding hook scripts on the filesystem across global and workspace
 * hook directories. Handles platform-specific discovery (Unix executable files vs
 * Windows PowerShell scripts) and expected filesystem errors gracefully.
 */
export class HookRegistry {
	/** Checks if a hooks directory is a global hooks directory (contains Dirac/Hooks path). */
	static isGlobalHooksDir(dir: string): boolean {
		return /[/\\][Dd]irac[/\\][Hh]ooks/i.test(dir)
	}

	/** Finds all hook scripts for the given hook name across all hooks directories. */
	static async findHookScripts(hookName: HookName): Promise<string[]> {
		const hookScripts = []
		for (const hooksDir of await getAllHooksDirs()) {
			hookScripts.push(HookRegistry.findHookInHooksDir(hookName, hooksDir))
		}
		const isDefined = (scriptPath: string | undefined): scriptPath is string => Boolean(scriptPath)
		return (await Promise.all(hookScripts)).filter(isDefined)
	}

	/** Finds the path to a hook in a hooks directory, dispatching by platform. */
	static async findHookInHooksDir(hookName: HookName, hooksDir: string): Promise<string | undefined> {
		return process.platform === "win32"
			? HookRegistry.findWindowsHook(hookName, hooksDir)
			: HookRegistry.findUnixHook(hookName, hooksDir)
	}

	/** Finds a hook on Windows by checking for a PowerShell hook file (`<HookName>.ps1`). */
	private static async findWindowsHook(hookName: HookName, hooksDir: string): Promise<string | undefined> {
		const powerShell = path.join(hooksDir, `${hookName}.ps1`)
		return (await HookRegistry.isHookFile(powerShell, hookName)) ? powerShell : undefined
	}

	/** Checks if a candidate path is a regular file, handling expected discovery errors. */
	private static async isHookFile(candidate: string, hookName: HookName): Promise<boolean> {
		try {
			const stat = await fs.stat(candidate)
			return stat.isFile()
		} catch (error) {
			HookRegistry.handleHookDiscoveryError(error, hookName, candidate)
			return false
		}
	}

	/** Finds a hook on Unix-like systems by checking for an executable file. */
	private static async findUnixHook(hookName: HookName, hooksDir: string): Promise<string | undefined> {
		const candidate = path.join(hooksDir, hookName)
		try {
			const [stat, _] = await Promise.all([fs.stat(candidate), fs.access(candidate, fs.constants.X_OK)])
			return stat.isFile() ? candidate : undefined
		} catch (error) {
			HookRegistry.handleHookDiscoveryError(error, hookName, candidate)
			return undefined
		}
	}

	/** Handles errors during hook discovery — silently ignores expected errors, propagates unexpected ones. */
	private static handleHookDiscoveryError(error: unknown, hookName: HookName, candidate: string): void {
		if (!isExpectedHookError(error)) {
			throw new Error(
				`Unexpected error while searching for hook '${hookName}' at '${candidate}': ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}
}
