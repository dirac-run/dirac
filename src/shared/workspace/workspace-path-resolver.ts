import type { WorkspaceRoot } from "@shared/multi-root/types"

/**
 * Narrow path-resolution surface needed by leaf layers. `WorkspaceResolver` (core) satisfies
 * this structurally and self-registers via `initializeWorkspacePathResolver`.
 */
export interface WorkspacePathResolver {
	resolveWorkspacePath(
		cwdOrRoots: string | WorkspaceRoot[],
		relativePath: string,
		context?: string,
	): string | { absolutePath: string; root: WorkspaceRoot }
	getBasename(filePath: string, context?: string): string
}

// Leaf layers must not import core's workspaceResolver singleton; core self-registers here
// at module load and leaves resolve lazily at call time.
let provider: (() => WorkspacePathResolver | undefined) | undefined

export function initializeWorkspacePathResolver(resolverProvider: () => WorkspacePathResolver | undefined): void {
	provider = resolverProvider
}

export function requireWorkspacePathResolver(): WorkspacePathResolver {
	const resolver = provider?.()
	if (!resolver) throw new Error("Workspace path resolver is not initialized")
	return resolver
}

/** Test seam — clears the registered provider. */
export function resetWorkspacePathResolver(): void {
	provider = undefined
}
