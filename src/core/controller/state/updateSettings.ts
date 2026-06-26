import { Empty } from "@shared/proto/dirac/common"
import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { DiracEnv } from "@/config"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { applyApiConfiguration } from "./settingsApiConfig"
import { mergeBrowserSettingsWebview } from "./settingsBrowser"
import { applyModeWebview } from "./settingsMode"
import { applyTelemetrySettingsWebview } from "./settingsTelemetry"
import { setDefaultTerminalProfile } from "./settingsTerminalProfile"
import {
	applyCustomPromptWebview,
	applyHooksEnabled,
	applySimpleSettings,
	applyToolToggles,
	normalizeVscodeTerminalExecutionMode,
} from "./settingsWebview"

/**
 * Updates multiple extension settings from a webview request in a single call
 * @param controller The controller instance
 * @param request The request containing the settings to update
 * @returns An empty response
 */
export async function updateSettings(controller: Controller, request: UpdateSettingsRequest): Promise<Empty> {
	try {
		if (request.diracEnv !== undefined) DiracEnv.setEnvironment(request.diracEnv)
		applyApiConfiguration(controller, request)
		if (request.telemetrySetting) await controller.updateTelemetrySetting(request.telemetrySetting as TelemetrySetting)
		applySimpleSettings(controller, request)
		applyModeWebview(controller, request)
		normalizeVscodeTerminalExecutionMode(controller, request)
		applyHooksEnabled(controller, request)
		applyTelemetrySettingsWebview(controller, request)
		applyCustomPromptWebview(controller, request)
		mergeBrowserSettingsWebview(controller, request)
		if (request.defaultTerminalProfile !== undefined) setDefaultTerminalProfile(controller, request.defaultTerminalProfile)
		applyToolToggles(controller, request)
		await controller.postStateToWebview()
		return Empty.create()
	} catch (error) {
		Logger.error("Failed to update settings:", error)
		throw error
	}
}
