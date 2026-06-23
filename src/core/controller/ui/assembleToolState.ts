import type { StateManager } from "@core/storage/StateManager"
import { refreshToolRegistryForWorkspace } from "@core/task/tools/registry/refreshToolRegistry"
import { ToolRegistry } from "@core/task/tools/registry/ToolRegistry"
import type { ExtensionState } from "@shared/ExtensionMessage"

/** Refreshes the tool registry for the workspace and returns the available tools + toggles. */
export async function assembleToolState(
	stateManager: StateManager,
	primaryRootPath: string | undefined,
): Promise<Pick<ExtensionState, "availableTools" | "toolToggles">> {
	const toolToggles = stateManager.getGlobalSettingsKey("toolToggles") || {}
	await refreshToolRegistryForWorkspace({ workspaceRoot: primaryRootPath, includeUserTools: true, toggles: toolToggles })
	const availableTools = ToolRegistry.getInstance()
		.getAllTools()
		.map((t) => ({
			id: t.id,
			name: t.name,
			description: t.spec.description,
			source: t.source,
			modulePath: t.modulePath,
		}))
	return { availableTools, toolToggles }
}
