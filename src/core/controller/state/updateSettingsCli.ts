import { Empty } from "@shared/proto/dirac/common"
import { Settings as ProtoSettings, UpdateSettingsRequestCli } from "@shared/proto/dirac/state"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { DiracEnv } from "@/config"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { rebuildApiHandlerIfTask } from "./settingsApiConfig"
import { mergeBrowserSettingsCli } from "./settingsBrowser"
import { applyApiProvider, applyReasoningEffort, filterSimpleSettingsBatch, mergeAutoApprovalSettings } from "./settingsCli"
import { applyModeCli } from "./settingsMode"
import { applyTelemetrySettingsCli } from "./settingsTelemetry"
import { setDefaultTerminalProfile } from "./settingsTerminalProfile"

/** Apply all settings from a CLI ProtoSettings object to global state */
async function applyCliSettings(controller: Controller, settings: ProtoSettings): Promise<void> {
	const {
		autoApprovalSettings,
		planModeReasoningEffort,
		actModeReasoningEffort,
		mode,
		customPrompt,
		planModeApiProvider,
		actModeApiProvider,
		telemetrySetting,
		yoloModeToggled,
		useAutoCondense,
		diracWebToolsEnabled,
		worktreesEnabled,
		subagentsEnabled,
		browserSettings,
		defaultTerminalProfile,
		...simpleSettings
	} = settings
	// Batch update for simple pass-through fields
	controller.stateManager.setGlobalStateBatch(filterSimpleSettingsBatch(simpleSettings))
	Logger.log("autoApprovalSettings", controller.stateManager.getGlobalSettingsKey("autoApprovalSettings"))
	// Fields requiring type conversion
	if (autoApprovalSettings) mergeAutoApprovalSettings(controller, autoApprovalSettings)
	applyReasoningEffort(controller, planModeReasoningEffort, actModeReasoningEffort)
	if (mode !== undefined) applyModeCli(controller, mode)
	if (customPrompt === "compact") controller.stateManager.setGlobalState("customPrompt", "compact")
	applyApiProvider(controller, planModeApiProvider, actModeApiProvider)
	rebuildApiHandlerIfTask(controller)
	// Telemetry setting
	if (telemetrySetting) await controller.updateTelemetrySetting(telemetrySetting as TelemetrySetting)
	// Settings with telemetry capture
	applyTelemetrySettingsCli(controller, {
		yoloModeToggled,
		useAutoCondense,
		diracWebToolsEnabled,
		worktreesEnabled,
		subagentsEnabled,
	})
	// Browser settings
	mergeBrowserSettingsCli(controller, browserSettings)
	// Terminal profile
	if (defaultTerminalProfile !== undefined && defaultTerminalProfile !== "")
		setDefaultTerminalProfile(controller, defaultTerminalProfile)
}

/**
 * Updates multiple extension settings from a CLI request
 * @param controller The controller instance
 * @param request The request containing the settings and secrets to update
 * @returns An empty response
 */
export async function updateSettingsCli(controller: Controller, request: UpdateSettingsRequestCli): Promise<Empty> {
	try {
		if (request.environment !== undefined) DiracEnv.setEnvironment(request.environment)
		if (request.settings) await applyCliSettings(controller, request.settings)
		if (request.secrets) {
			const filteredSecrets = Object.fromEntries(
				Object.entries(request.secrets).filter(([_, value]) => value !== undefined),
			)
			controller.stateManager.setSecretsBatch(filteredSecrets)
		}
		await controller.postStateToWebview()
		return Empty.create()
	} catch (error) {
		throw error
	}
}
