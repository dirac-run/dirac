import { isDirectory } from "@utils/fs"
import * as path from "path"
import { StateManager } from "./StateManager"
import { GlobalFileNames } from "./fileNames"
import { ensureHooksDirectoryExists } from "./directoryEnsurers"

let runtimeHooksDir: string | undefined

// Sets a runtime hooks directory, typically passed via the --hooks-dir CLI flag.
export function setRuntimeHooksDir(dir: string | undefined): void {
	runtimeHooksDir = dir
}

// Gets the path to the global hooks directory if it exists, otherwise undefined.
export async function getGlobalHooksDir(): Promise<string | undefined> {
	const globalHooksDir = await ensureHooksDirectoryExists()
	return (await isDirectory(globalHooksDir)) ? globalHooksDir : undefined
}

// Gets all hooks directories to search: runtime (CLI flag), global, and per-workspace.
export async function getAllHooksDirs(): Promise<string[]> {
	const hooksDirs: string[] = []
	if (runtimeHooksDir && (await isDirectory(runtimeHooksDir))) {
		hooksDirs.push(runtimeHooksDir)
	}
	const globalHooksDir = await getGlobalHooksDir()
	if (globalHooksDir) {
		hooksDirs.push(globalHooksDir)
	}
	const workspaceHooksDirs = await getWorkspaceHooksDirs()
	hooksDirs.push(...workspaceHooksDirs)
	return hooksDirs
}

// Gets the workspace .diracrules/hooks directories that exist across all workspace roots.
export async function getWorkspaceHooksDirs(): Promise<string[]> {
	const workspaceRootPaths =
		StateManager.get()
			.getGlobalStateKey("workspaceRoots")
			?.map((root) => root.path) || []
	return (
		await Promise.all(
			workspaceRootPaths.map(async (workspaceRootPath) => {
				const candidate = path.join(workspaceRootPath, GlobalFileNames.hooksDir)
				return (await isDirectory(candidate)) ? candidate : undefined
			}),
		)
	).filter((path): path is string => Boolean(path))
}
