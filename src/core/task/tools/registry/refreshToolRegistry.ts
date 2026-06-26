import { StateManager } from "@/core/storage/StateManager"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import { UserToolLoader } from "../discovery/UserToolLoader"
import { ToolDiscoveryService } from "../discovery/ToolDiscoveryService"
import { ToolRegistry } from "./ToolRegistry"

export function ensureBuiltinToolsRegistered(): void {
	const registry = ToolRegistry.getInstance()
	if (registry.hasBuiltinTools()) {
		return
	}

	for (const tool of ToolDiscoveryService.scanBuiltinTools()) {
		registry.registerBuiltin(tool)
	}
}

export async function refreshToolRegistryForWorkspace(options: {
	workspaceRoot?: string
	includeUserTools: boolean
	toggles?: Record<string, boolean>
}): Promise<void> {
	ensureBuiltinToolsRegistered()

	const registry = ToolRegistry.getInstance()
	registry.loadToggles(options.toggles ?? StateManager.get().getGlobalSettingsKey("toolToggles") ?? {})

	if (!options.includeUserTools) {
		return
	}

	registry.clearUserTools()

	const globalTools = await ToolDiscoveryService.scanGlobalUserTools()
	const workspaceTools = options.workspaceRoot ? await ToolDiscoveryService.scanWorkspaceTools(options.workspaceRoot) : []
	const userTools: DiscoveredTool[] = [...globalTools, ...workspaceTools]

	for (const tool of userTools) {
		registry.registerUserTool(tool)
	}
	// Purge compiled cache files for tools that no longer exist
	await UserToolLoader.purgeStaleCache(userTools.map((t) => t.id))
}
