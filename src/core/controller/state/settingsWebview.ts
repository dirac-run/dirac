import { isValidAutoCondenseContextLimit } from "@shared/context-management"
import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { convertProtoToModelProviderSelection } from "@shared/proto-conversions/models/api-configuration-conversion"
import type { Settings } from "@shared/storage/state-keys"
import { normalizeUserApprovedCommands } from "@shared/UserApprovedCommand"
import { Controller } from ".."

/**
 * Build the complete explicitly addressed Settings patch for a webview update.
 * Constructor-only execution options remain persistence-only because they are
 * not represented by TaskWorkingConfiguration.settings.
 */
export function buildWebviewSettingsPatch(request: UpdateSettingsRequest): Partial<Settings> {
	const settings: Partial<Settings> = {}
	if (request.planActSeparateModelsSetting !== undefined)
		settings.planActSeparateModelsSetting = request.planActSeparateModelsSetting
	if (request.enableCheckpointsSetting !== undefined) settings.enableCheckpointsSetting = request.enableCheckpointsSetting
	if (request.utilityModelEnabled !== undefined) settings.utilityModelEnabled = request.utilityModelEnabled
	if (request.utilityModelSelection !== undefined)
		settings.utilityModelSelection = convertProtoToModelProviderSelection(request.utilityModelSelection)
	if (request.utilityModelUseCondense !== undefined) settings.utilityModelUseCondense = request.utilityModelUseCondense
	if (request.utilityModelUseGenerateCommitMessage !== undefined)
		settings.utilityModelUseGenerateCommitMessage = request.utilityModelUseGenerateCommitMessage
	if (request.utilityModelUsePermissionHandling !== undefined)
		settings.utilityModelUsePermissionHandling = request.utilityModelUsePermissionHandling
	if (request.utilityModelPermissionPolicy !== undefined)
		settings.utilityModelPermissionPolicy = request.utilityModelPermissionPolicy
	if (request.preferredLanguage !== undefined) settings.preferredLanguage = request.preferredLanguage
	if (request.shellIntegrationTimeout !== undefined) settings.shellIntegrationTimeout = Number(request.shellIntegrationTimeout)
	if (request.terminalOutputLineLimit !== undefined) settings.terminalOutputLineLimit = Number(request.terminalOutputLineLimit)
	if (request.maxConsecutiveMistakes !== undefined) settings.maxConsecutiveMistakes = Number(request.maxConsecutiveMistakes)
	if (request.strictPlanModeEnabled !== undefined) settings.strictPlanModeEnabled = request.strictPlanModeEnabled
	if (request.autoCondenseContextLimits !== undefined) {
		settings.autoCondenseContextLimits = Object.fromEntries(
			Object.entries(request.autoCondenseContextLimits.limits).filter(([, value]) =>
				isValidAutoCondenseContextLimit(value),
			),
		)
	}
	if (request.worktreesEnabled !== undefined) settings.worktreesEnabled = request.worktreesEnabled
	if (request.lowVerbosityEnabled !== undefined) settings.lowVerbosityEnabled = request.lowVerbosityEnabled
	if (request.writePromptMetadataEnabled !== undefined) settings.writePromptMetadataEnabled = request.writePromptMetadataEnabled
	if (request.autoApproveAllToggled !== undefined) settings.autoApproveAllToggled = request.autoApproveAllToggled
	if (request.userApprovedCommands !== undefined)
		settings.userApprovedCommands = normalizeUserApprovedCommands(request.userApprovedCommands.commands)
	if (request.writePromptMetadataDirectory !== undefined)
		settings.writePromptMetadataDirectory = request.writePromptMetadataDirectory
	if (request.backgroundEditEnabled !== undefined) settings.backgroundEditEnabled = !!request.backgroundEditEnabled
	if (request.enableParallelToolCalling !== undefined) settings.enableParallelToolCalling = !!request.enableParallelToolCalling
	if (request.hooksEnabled !== undefined) settings.hooksEnabled = !!request.hooksEnabled
	if (request.customPrompt !== undefined) settings.customPrompt = request.customPrompt === "compact" ? "compact" : undefined
	if (request.yoloModeToggled !== undefined) settings.yoloModeToggled = request.yoloModeToggled
	if (request.diracWebToolsEnabled !== undefined) settings.diracWebToolsEnabled = request.diracWebToolsEnabled
	if (request.subagentsEnabled !== undefined) settings.subagentsEnabled = !!request.subagentsEnabled
	if (request.useAutoCondense !== undefined) settings.useAutoCondense = request.useAutoCondense
	return settings
}

/** Persist an already normalized webview Settings patch. */
export function persistWebviewSettingsPatch(controller: Controller, settings: Partial<Settings>): void {
	if (Object.keys(settings).length > 0) controller.stateManager.setGlobalStateBatch(settings)
}

/** Apply simple boolean/number/string settings that map directly to global state. */
export function applySimpleSettings(controller: Controller, request: UpdateSettingsRequest): void {
	persistWebviewSettingsPatch(controller, buildWebviewSettingsPatch(request))
}

/** Normalize vscode terminal execution mode to 'backgroundExec' or 'vscodeTerminal'. */
export function normalizeVscodeTerminalExecutionMode(controller: Controller, request: UpdateSettingsRequest): void {
	if (request.vscodeTerminalExecutionMode === undefined || request.vscodeTerminalExecutionMode === "") return
	const normalized = request.vscodeTerminalExecutionMode === "backgroundExec" ? "backgroundExec" : "vscodeTerminal"
	controller.stateManager.setGlobalState("vscodeTerminalExecutionMode", normalized)
}
