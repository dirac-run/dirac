import { StateManager } from "@/core/storage/StateManager"
import { refreshToolRegistryForWorkspace } from "../../../task/tools/registry/refreshToolRegistry"

/**
 * Compatibility initialization hook for callers that still invoke the legacy
 * registration function. Tool schemas are now derived from ToolRegistry at
 * prompt build time, not registered into DiracToolSet here.
 */
export function registerDiracToolSets(): void {
    void refreshToolRegistryForWorkspace({
        includeUserTools: false,
        toggles: StateManager.get().getGlobalSettingsKey("toolToggles") || {},
    })
}
