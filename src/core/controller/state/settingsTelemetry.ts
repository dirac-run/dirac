import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { telemetryService } from "../../../services/telemetry"
import { Controller } from ".."

/** Apply webview telemetry-gated toggle settings: yolo, webTools, subagents, autoCondense */
export function applyTelemetrySettingsWebview(controller: Controller, request: UpdateSettingsRequest): void {
	if (request.yoloModeToggled !== undefined) {
		if (controller.task) telemetryService.captureYoloModeToggle(controller.task.ulid, request.yoloModeToggled)
		controller.stateManager.setGlobalState("yoloModeToggled", request.yoloModeToggled)
	}
	if (request.diracWebToolsEnabled !== undefined) {
		if (controller.task) telemetryService.captureDiracWebToolsToggle(controller.task.ulid, request.diracWebToolsEnabled)
		controller.stateManager.setGlobalState("diracWebToolsEnabled", request.diracWebToolsEnabled)
	}
	if (request.subagentsEnabled !== undefined) {
		const wasEnabled = controller.stateManager.getGlobalSettingsKey("subagentsEnabled") ?? false
		const isEnabled = !!request.subagentsEnabled
		controller.stateManager.setGlobalState("subagentsEnabled", isEnabled)
		if (wasEnabled !== isEnabled) telemetryService.captureSubagentToggle(isEnabled)
	}
	if (request.useAutoCondense !== undefined) {
		if (controller.task)
			telemetryService.captureAutoCondenseToggle(
				controller.task.ulid,
				request.useAutoCondense,
				controller.task.api.getModel().id,
			)
		controller.stateManager.setGlobalState("useAutoCondense", request.useAutoCondense)
	}
}

/** Apply CLI telemetry-gated toggle settings: yolo, autoCondense, webTools, worktrees, subagents */
export function applyTelemetrySettingsCli(controller: Controller, fields: any): void {
	if (fields.yoloModeToggled !== undefined) {
		if (controller.task) telemetryService.captureYoloModeToggle(controller.task.ulid, fields.yoloModeToggled)
		controller.stateManager.setGlobalState("yoloModeToggled", fields.yoloModeToggled)
	}
	if (fields.useAutoCondense !== undefined) {
		if (controller.task)
			telemetryService.captureAutoCondenseToggle(
				controller.task.ulid,
				fields.useAutoCondense,
				controller.task.api.getModel().id,
			)
		controller.stateManager.setGlobalState("useAutoCondense", fields.useAutoCondense)
	}
	if (fields.diracWebToolsEnabled !== undefined) {
		if (controller.task) telemetryService.captureDiracWebToolsToggle(controller.task.ulid, fields.diracWebToolsEnabled)
		controller.stateManager.setGlobalState("diracWebToolsEnabled", fields.diracWebToolsEnabled)
	}
	if (fields.worktreesEnabled !== undefined) controller.stateManager.setGlobalState("worktreesEnabled", fields.worktreesEnabled)
	if (fields.subagentsEnabled !== undefined) {
		const wasEnabled = controller.stateManager.getGlobalSettingsKey("subagentsEnabled") ?? false
		const isEnabled = !!fields.subagentsEnabled
		controller.stateManager.setGlobalState("subagentsEnabled", isEnabled)
		if (wasEnabled !== isEnabled) telemetryService.captureSubagentToggle(isEnabled)
	}
}
