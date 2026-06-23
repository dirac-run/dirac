import { Empty } from "@shared/proto/dirac/common"
import { PlanActMode, UpdateTaskSettingsRequest } from "@shared/proto/dirac/state"
import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import { Mode } from "@/shared/storage/types"
import { Controller } from ".."
import { normalizeOpenaiReasoningEffort } from "./reasoningEffort"

/** Convert proto PlanActMode to internal mode string */
function convertPlanActMode(mode: PlanActMode): Mode {
	return mode === PlanActMode.PLAN ? "plan" : "act"
}

/** Resolve taskId from request or fall back to active task */
function resolveTaskId(controller: Controller, request: UpdateTaskSettingsRequest): string {
	if (request.taskId) return request.taskId
	if (!controller.task) throw new Error("No active task to update settings for")
	return controller.task.taskId
}

/** Merge autoApprovalSettings preserving unspecified fields from current settings */
function mergeAutoApprovalSettings(controller: Controller, taskId: string, autoApprovalSettings: any): void {
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
	controller.stateManager.setTaskSettings(taskId, "autoApprovalSettings", merged)
}

/** Handle fields requiring type conversion from protobuf to application types */
function handleConversionFields(controller: Controller, taskId: string, fields: any): void {
	if (fields.autoApprovalSettings) mergeAutoApprovalSettings(controller, taskId, fields.autoApprovalSettings)
	if (fields.planModeReasoningEffort !== undefined)
		controller.stateManager.setTaskSettings(
			taskId,
			"planModeReasoningEffort",
			normalizeOpenaiReasoningEffort(fields.planModeReasoningEffort),
		)
	if (fields.actModeReasoningEffort !== undefined)
		controller.stateManager.setTaskSettings(
			taskId,
			"actModeReasoningEffort",
			normalizeOpenaiReasoningEffort(fields.actModeReasoningEffort),
		)
	if (fields.mode !== undefined) controller.stateManager.setTaskSettings(taskId, "mode", convertPlanActMode(fields.mode))
	if (fields.customPrompt === "compact") controller.stateManager.setTaskSettings(taskId, "customPrompt", "compact")
	if (fields.planModeApiProvider !== undefined)
		controller.stateManager.setTaskSettings(
			taskId,
			"planModeApiProvider",
			convertProtoToApiProvider(fields.planModeApiProvider),
		)
	if (fields.actModeApiProvider !== undefined)
		controller.stateManager.setTaskSettings(
			taskId,
			"actModeApiProvider",
			convertProtoToApiProvider(fields.actModeApiProvider),
		)
}

/** Merge browser settings from request with existing settings */
function handleBrowserSettings(controller: Controller, taskId: string, browserSettings: any): void {
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
	controller.stateManager.setTaskSettings(taskId, "browserSettings", merged)
}

/** Process all task settings from the request */
function processTaskSettings(controller: Controller, taskId: string, settings: any): void {
	const {
		autoApprovalSettings,
		planModeReasoningEffort,
		actModeReasoningEffort,
		mode,
		customPrompt,
		planModeApiProvider,
		actModeApiProvider,
		browserSettings,
		...simpleSettings
	} = settings
	// Batch update for simple pass-through fields
	const filteredSettings: any = Object.fromEntries(
		Object.entries(simpleSettings).filter(([key, value]) => key !== "openaiReasoningEffort" && value !== undefined),
	)
	controller.stateManager.setTaskSettingsBatch(taskId, filteredSettings)
	// Handle fields requiring type conversion
	handleConversionFields(controller, taskId, {
		autoApprovalSettings,
		planModeReasoningEffort,
		actModeReasoningEffort,
		mode,
		customPrompt,
		planModeApiProvider,
		actModeApiProvider,
	})
	// Handle browser settings
	handleBrowserSettings(controller, taskId, browserSettings)
}

/**
 * Updates task-specific settings for the current task
 * @param controller The controller instance
 * @param request The request containing the task settings to update
 * @returns An empty response
 */
export async function updateTaskSettings(controller: Controller, request: UpdateTaskSettingsRequest): Promise<Empty> {
	try {
		const taskId = resolveTaskId(controller, request)
		if (request.settings) processTaskSettings(controller, taskId, request.settings)
		await controller.postStateToWebview()
		return Empty.create()
	} catch (error) {
		throw error
	}
}
