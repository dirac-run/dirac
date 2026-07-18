import { ToolRegistry } from "@core/task/tools/registry/ToolRegistry"
import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { telemetryService } from "../../../services/telemetry"
import { Controller } from ".."

/** Apply simple boolean/number/string settings that map directly to global state */
export function applySimpleSettings(controller: Controller, request: UpdateSettingsRequest): void {
	const sm = controller.stateManager
	if (request.planActSeparateModelsSetting !== undefined)
		sm.setGlobalState("planActSeparateModelsSetting", request.planActSeparateModelsSetting)
	if (request.enableCheckpointsSetting !== undefined)
		sm.setGlobalState("enableCheckpointsSetting", request.enableCheckpointsSetting)
	if (request.preferredLanguage !== undefined) sm.setGlobalState("preferredLanguage", request.preferredLanguage)
	if (request.shellIntegrationTimeout !== undefined)
		sm.setGlobalState("shellIntegrationTimeout", Number(request.shellIntegrationTimeout))
	if (request.terminalReuseEnabled !== undefined) sm.setGlobalState("terminalReuseEnabled", request.terminalReuseEnabled)
	if (request.terminalOutputLineLimit !== undefined)
		sm.setGlobalState("terminalOutputLineLimit", Number(request.terminalOutputLineLimit))
	if (request.maxConsecutiveMistakes !== undefined)
		sm.setGlobalState("maxConsecutiveMistakes", Number(request.maxConsecutiveMistakes))
	if (request.strictPlanModeEnabled !== undefined) sm.setGlobalState("strictPlanModeEnabled", request.strictPlanModeEnabled)
	if (request.worktreesEnabled !== undefined) sm.setGlobalState("worktreesEnabled", request.worktreesEnabled)
	if (request.doubleCheckCompletionEnabled !== undefined)
		sm.setGlobalState("doubleCheckCompletionEnabled", request.doubleCheckCompletionEnabled)
	if (request.writePromptMetadataEnabled !== undefined)
		sm.setGlobalState("writePromptMetadataEnabled", request.writePromptMetadataEnabled)
	if (request.autoApproveAllToggled !== undefined) sm.setGlobalState("autoApproveAllToggled", request.autoApproveAllToggled)
	if (request.writePromptMetadataDirectory !== undefined)
		sm.setGlobalState("writePromptMetadataDirectory", request.writePromptMetadataDirectory)
	if (request.backgroundEditEnabled !== undefined) sm.setGlobalState("backgroundEditEnabled", !!request.backgroundEditEnabled)
	if (request.multiRootEnabled !== undefined) sm.setGlobalState("multiRootEnabled", !!request.multiRootEnabled)
	if (request.enableParallelToolCalling !== undefined)
		sm.setGlobalState("enableParallelToolCalling", !!request.enableParallelToolCalling)
}

/** Normalize vscode terminal execution mode to 'backgroundExec' or 'vscodeTerminal' */
export function normalizeVscodeTerminalExecutionMode(controller: Controller, request: UpdateSettingsRequest): void {
	if (request.vscodeTerminalExecutionMode === undefined || request.vscodeTerminalExecutionMode === "") return
	const normalized = request.vscodeTerminalExecutionMode === "backgroundExec" ? "backgroundExec" : "vscodeTerminal"
	controller.stateManager.setGlobalState("vscodeTerminalExecutionMode", normalized)
}

/** Apply hooksEnabled setting with telemetry capture on state change */
export function applyHooksEnabled(controller: Controller, request: UpdateSettingsRequest): void {
	if (request.hooksEnabled === undefined) return
	const wasEnabled = controller.stateManager.getGlobalSettingsKey("hooksEnabled") ?? true
	const isEnabled = !!request.hooksEnabled
	controller.stateManager.setGlobalState("hooksEnabled", isEnabled)
	if (controller.task && wasEnabled !== isEnabled) {
		telemetryService.captureFeatureToggle(controller.task.ulid, "hooks", isEnabled, controller.task.api.getModel().id)
	}
}

/** Apply customPrompt — only 'compact' is a valid value, otherwise set to undefined */
export function applyCustomPromptWebview(controller: Controller, request: UpdateSettingsRequest): void {
	if (request.customPrompt === undefined) return
	const value = request.customPrompt === "compact" ? "compact" : undefined
	controller.stateManager.setGlobalState("customPrompt", value)
}

/** Parse tool toggles JSON, sync to ToolRegistry, and mark task tools dirty */
export function applyToolToggles(controller: Controller, request: UpdateSettingsRequest): void {
	if (request.toolToggles === undefined) return
	const toggles = JSON.parse(request.toolToggles) as Record<string, boolean>
	const registry = ToolRegistry.getInstance()
	registry.loadToggles(toggles)
	controller.stateManager.setGlobalState("toolToggles", registry.getToggles())
	controller.task?.markToolsDirty("tool_toggles_changed")
}
