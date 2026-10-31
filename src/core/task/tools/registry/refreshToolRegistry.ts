import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import * as path from "path"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import { UserToolLoader } from "../discovery/UserToolLoader"
import { ToolDiscoveryService } from "../discovery/ToolDiscoveryService"
import { ToolRegistry } from "./ToolRegistry"

export interface RefreshToolRegistryOptions {
	workspaceRoot?: string
	includeUserTools: boolean
	toggles?: Record<string, boolean>
	forceRefresh?: boolean
}

function registerBuiltinTools(registry: ToolRegistry): void {
	if (registry.hasBuiltinTools()) return
	for (const tool of ToolDiscoveryService.scanBuiltinTools()) registry.registerBuiltin(tool)
}


export function refreshToolRegistryForWorkspace(options: RefreshToolRegistryOptions): Promise<void>
export function refreshToolRegistryForWorkspace<T>(
	options: RefreshToolRegistryOptions,
	capture: (registry: ToolRegistry) => T | Promise<T>,
): Promise<T>
/** Refresh and optionally capture registry state without allowing another global mutation to interleave. */
export async function refreshToolRegistryForWorkspace<T>(
	options: RefreshToolRegistryOptions,
	capture?: (registry: ToolRegistry) => T | Promise<T>,
): Promise<T | void> {
	return ToolRegistry.withExclusiveAccess(async (registry) => {
		registerBuiltinTools(registry)

		if (options.includeUserTools) {
			const globalTools = await ToolDiscoveryService.scanGlobalUserTools()
			const workspaceTools = options.workspaceRoot ? await ToolDiscoveryService.scanWorkspaceTools(options.workspaceRoot, options.toggles) : []
			const userTools: DiscoveredTool[] = [...globalTools, ...workspaceTools]
			registry.reconcileWorkspaceUserTools(userTools, options.forceRefresh, options.workspaceRoot)
			await UserToolLoader.purgeStaleCache(registry.getKnownUserToolIds())

		}

		registry.loadToggles(options.toggles ?? {})
		return capture?.(registry)
	})
}

/** Scan task tools first, then register the complete result under global-registry exclusivity. */
export async function refreshTaskTools(taskId: string, storageAddress: string | TaskStorageAddress = taskId): Promise<string[]> {
	const { ensureTaskDirectoryExists } = await import("@core/storage/disk")
	const taskDir = await ensureTaskDirectoryExists(storageAddress)
	const toolsDir = path.join(taskDir, "tools")
	const taskTools = (await ToolDiscoveryService.scanUserToolDirectory(toolsDir, "task")).map((tool) => ({
		...tool,
		ownerTaskId: taskId,
	}))
	return ToolRegistry.withExclusiveAccess((registry) => registry.reconcileTaskTools(taskId, taskTools))
}
