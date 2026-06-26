import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import { Settings } from "@shared/storage/state-keys"
import { Controller } from ".."
import { normalizeOpenaiReasoningEffort } from "./reasoningEffort"

/** Merge autoApprovalSettings preserving unspecified fields from current settings */
export function mergeAutoApprovalSettings(controller: Controller, autoApprovalSettings: any): void {
	const current = controller.stateManager.getGlobalSettingsKey("autoApprovalSettings")
	const merged = {
		...current,
		...(autoApprovalSettings.version !== undefined && { version: autoApprovalSettings.version }),
		...(autoApprovalSettings.enableNotifications !== undefined && {
			enableNotifications: autoApprovalSettings.enableNotifications,
		}),
		actions: {
			...current.actions,
			...(autoApprovalSettings.actions
				? Object.fromEntries(Object.entries(autoApprovalSettings.actions).filter(([_, v]) => v !== undefined))
				: {}),
		},
	}
	controller.stateManager.setGlobalState("autoApprovalSettings", merged)
}

/** Normalize and apply reasoning effort settings for plan and act modes */
export function applyReasoningEffort(controller: Controller, planMode: any, actMode: any): void {
	if (planMode !== undefined)
		controller.stateManager.setGlobalState("planModeReasoningEffort", normalizeOpenaiReasoningEffort(planMode))
	if (actMode !== undefined)
		controller.stateManager.setGlobalState("actModeReasoningEffort", normalizeOpenaiReasoningEffort(actMode))
}

/** Convert and apply API provider settings for plan and act modes */
export function applyApiProvider(controller: Controller, planMode: any, actMode: any): void {
	if (planMode !== undefined) controller.stateManager.setGlobalState("planModeApiProvider", convertProtoToApiProvider(planMode))
	if (actMode !== undefined) controller.stateManager.setGlobalState("actModeApiProvider", convertProtoToApiProvider(actMode))
}

/** Filter simple settings for batch update — excludes openaiReasoningEffort and undefined values */
export function filterSimpleSettingsBatch(simpleSettings: any): Partial<Settings> {
	return Object.fromEntries(
		Object.entries(simpleSettings).filter(([key, value]) => key !== "openaiReasoningEffort" && value !== undefined),
	)
}
