import { PlanActMode, UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { Mode } from "@/shared/storage/types"
import { Controller } from ".."

/** Convert proto PlanActMode to internal mode string (undefined-aware for webview) */
export function convertMode(mode: PlanActMode | undefined): Mode | undefined {
	if (mode === undefined) return undefined
	return mode === PlanActMode.PLAN ? "plan" : "act"
}

/** Apply mode from webview request — sets both global state and session override */
export function applyModeWebview(controller: Controller, request: UpdateSettingsRequest): void {
	const mode = convertMode(request.mode)
	if (mode === undefined) return
	controller.stateManager.setGlobalState("mode", mode)
	controller.stateManager.setSessionOverride("mode", mode)
}

/** Convert proto PlanActMode to internal mode string (non-undefined for CLI) */
export function convertPlanActMode(mode: PlanActMode): Mode {
	return mode === PlanActMode.PLAN ? "plan" : "act"
}

/** Apply mode from CLI — sets both global state and session override */
export function applyModeCli(controller: Controller, mode: PlanActMode): void {
	const converted = convertPlanActMode(mode)
	controller.stateManager.setGlobalState("mode", converted)
	controller.stateManager.setSessionOverride("mode", converted)
}
