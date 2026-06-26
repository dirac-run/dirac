import { buildApiHandler } from "@core/api"
import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { convertProtoToApiConfiguration } from "@shared/proto-conversions/models/api-configuration-conversion"
import { Controller } from ".."

/** Apply API configuration from webview request and rebuild handler if task is active */
export function applyApiConfiguration(controller: Controller, request: UpdateSettingsRequest): void {
	if (!request.apiConfiguration) return
	const converted = convertProtoToApiConfiguration(request.apiConfiguration)
	controller.stateManager.setApiConfiguration(converted)
	if (!controller.task) return
	const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
	controller.task.api = buildApiHandler({ ...converted, ulid: controller.task.ulid }, currentMode)
}

/** Rebuild API handler from current state if a task is active */
export function rebuildApiHandlerIfTask(controller: Controller): void {
	if (!controller.task) return
	const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
	controller.task.api = buildApiHandler(
		{ ...controller.stateManager.getApiConfiguration(), ulid: controller.task.ulid },
		currentMode,
	)
}
