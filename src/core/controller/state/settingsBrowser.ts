import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { BrowserSettings as SharedBrowserSettings } from "../../../shared/BrowserSettings"
import { Controller } from ".."

/** Merge browser settings from webview request — uses `in` check for protobuf-es fields that always include the key */
export function mergeBrowserSettingsWebview(controller: Controller, request: UpdateSettingsRequest): void {
	if (request.browserSettings === undefined) return
	const current = controller.stateManager.getGlobalSettingsKey("browserSettings")
	const req = request.browserSettings
	const merged: SharedBrowserSettings = {
		...current,
		viewport: {
			width: req.viewport?.width || current.viewport.width,
			height: req.viewport?.height || current.viewport.height,
		},
		remoteBrowserEnabled: req.remoteBrowserEnabled === undefined ? current.remoteBrowserEnabled : req.remoteBrowserEnabled,
		remoteBrowserHost: req.remoteBrowserHost === undefined ? current.remoteBrowserHost : req.remoteBrowserHost,
		// Protobuf-es always includes the key (set to undefined), so `in` check is always true
		chromeExecutablePath: "chromeExecutablePath" in req ? req.chromeExecutablePath : current.chromeExecutablePath,
		disableToolUse: req.disableToolUse === undefined ? current.disableToolUse : req.disableToolUse,
		customArgs: "customArgs" in req ? req.customArgs : current.customArgs,
	}
	controller.stateManager.setGlobalState("browserSettings", merged)
}

/** Merge browser settings from CLI request — uses `!== undefined` check for explicitly set fields */
export function mergeBrowserSettingsCli(controller: Controller, browserSettings: any): void {
	if (browserSettings === undefined) return
	const current = controller.stateManager.getGlobalSettingsKey("browserSettings")
	const merged = {
		...current,
		viewport: {
			width: browserSettings.viewport?.width || current.viewport.width,
			height: browserSettings.viewport?.height || current.viewport.height,
		},
		...(browserSettings.remoteBrowserEnabled !== undefined && { remoteBrowserEnabled: browserSettings.remoteBrowserEnabled }),
		...(browserSettings.remoteBrowserHost !== undefined && { remoteBrowserHost: browserSettings.remoteBrowserHost }),
		...(browserSettings.chromeExecutablePath !== undefined && { chromeExecutablePath: browserSettings.chromeExecutablePath }),
		...(browserSettings.disableToolUse !== undefined && { disableToolUse: browserSettings.disableToolUse }),
		...(browserSettings.customArgs !== undefined && { customArgs: browserSettings.customArgs }),
	}
	controller.stateManager.setGlobalState("browserSettings", merged)
}
