import type { DeepReadonly, TaskWorkingConfigurationPatch } from "@core/task/runtime/TaskWorkingConfiguration"
import { Empty } from "@shared/proto/dirac/common"
import { PlanActMode, UpdateTaskSettingsRequest } from "@shared/proto/dirac/state"
import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import type { Settings } from "@shared/storage/state-keys"
import type { Mode } from "@/shared/storage/types"
import type { Controller } from ".."
import { normalizeOpenaiReasoningEffort } from "./reasoningEffort"

/** Convert proto PlanActMode to internal mode string. */
function convertPlanActMode(mode: PlanActMode): Mode {
	return mode === PlanActMode.PLAN ? "plan" : "act"
}

/** Resolve taskId from request or fall back to active task. */
function resolveTaskId(controller: Controller, request: UpdateTaskSettingsRequest): string {
	if (request.taskId) return request.taskId
	if (!controller.task) throw new Error("No active task to update settings for")
	return controller.task.taskId
}

function mergeAutoApprovalSettings(
	controller: Controller,
	autoApprovalSettings: any,
	activeSettings?: DeepReadonly<Settings>,
): Settings["autoApprovalSettings"] {
	const current = structuredClone(
		activeSettings?.autoApprovalSettings ?? controller.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
	) as Settings["autoApprovalSettings"]
	return {
		...current,
		...(autoApprovalSettings.version !== undefined && { version: autoApprovalSettings.version }),
		...(autoApprovalSettings.enableNotifications !== undefined && {
			enableNotifications: autoApprovalSettings.enableNotifications,
		}),
		actions: {
			...current.actions,
			...(autoApprovalSettings.actions
				? Object.fromEntries(Object.entries(autoApprovalSettings.actions).filter(([, value]) => value !== undefined))
				: {}),
		},
	}
}

function mergeBrowserSettings(
	controller: Controller,
	browserSettings: any,
	activeSettings?: DeepReadonly<Settings>,
): Settings["browserSettings"] | undefined {
	if (browserSettings === undefined) return undefined
	const current = activeSettings?.browserSettings ?? controller.stateManager.getGlobalSettingsKey("browserSettings")
	return {
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
}

type PreparedTaskSettings = {
	settingsPatch: Partial<Settings>
	simpleSettings: Partial<Settings>
	autoApprovalSettings?: Settings["autoApprovalSettings"]
	browserSettings?: Settings["browserSettings"]
}

function prepareTaskSettings(
	controller: Controller,
	settings: any,
	activeSettings?: DeepReadonly<Settings>,
): PreparedTaskSettings {
	if (settings.subagentRoles !== undefined) throw new Error("Subagent roles are user-global settings")
	const {
		autoApprovalSettings: incomingAutoApprovalSettings,
		planModeReasoningEffort,
		actModeReasoningEffort,
		mode,
		customPrompt,
		planModeApiProvider,
		actModeApiProvider,
		browserSettings: incomingBrowserSettings,
		utilityModelEnabled: _utilityModelEnabled,
		utilityModelSelection: _utilityModelSelection,
		utilityModelUseCondense: _utilityModelUseCondense,
		utilityModelUseGenerateCommitMessage: _utilityModelUseGenerateCommitMessage,
		...simpleValues
	} = settings

	const simpleSettings = Object.fromEntries(
		Object.entries(simpleValues).filter(([key, value]) => key !== "openaiReasoningEffort" && value !== undefined),
	) as Partial<Settings>
	const settingsPatch: Partial<Settings> = { ...simpleSettings }

	const autoApprovalSettings = incomingAutoApprovalSettings
		? mergeAutoApprovalSettings(controller, incomingAutoApprovalSettings, activeSettings)
		: undefined
	if (autoApprovalSettings !== undefined) settingsPatch.autoApprovalSettings = autoApprovalSettings
	if (planModeReasoningEffort !== undefined) {
		settingsPatch.planModeReasoningEffort = normalizeOpenaiReasoningEffort(planModeReasoningEffort)
	}
	if (actModeReasoningEffort !== undefined) {
		settingsPatch.actModeReasoningEffort = normalizeOpenaiReasoningEffort(actModeReasoningEffort)
	}
	if (mode !== undefined) settingsPatch.mode = convertPlanActMode(mode)
	if (customPrompt === "compact") settingsPatch.customPrompt = "compact"
	if (planModeApiProvider !== undefined) settingsPatch.planModeApiProvider = convertProtoToApiProvider(planModeApiProvider)
	if (actModeApiProvider !== undefined) settingsPatch.actModeApiProvider = convertProtoToApiProvider(actModeApiProvider)

	const browserSettings = mergeBrowserSettings(controller, incomingBrowserSettings, activeSettings)
	if (browserSettings !== undefined) settingsPatch.browserSettings = browserSettings

	return { settingsPatch, simpleSettings, autoApprovalSettings, browserSettings }
}

function persistTaskSettings(controller: Controller, taskId: string, prepared: PreparedTaskSettings): void {
	const stateManager = controller.stateManager
	const keys = Object.keys(prepared.settingsPatch) as Array<keyof Settings>
	const previousValues: Partial<Settings> = {}
	const previouslyOwned = new Set<keyof Settings>()
	for (const key of keys) {
		if (stateManager.hasTaskSetting(key)) previouslyOwned.add(key)
			; (previousValues as Record<string, unknown>)[key] = structuredClone(stateManager.getTaskSetting(key))
	}

	try {
		stateManager.setTaskSettingsBatch(taskId, prepared.settingsPatch)
	} catch (error) {
		try {
			const ownedValues = Object.fromEntries(
				keys.filter((key) => previouslyOwned.has(key)).map((key) => [key, previousValues[key]]),
			) as Partial<Settings>
			if (Object.keys(ownedValues).length > 0) stateManager.setTaskSettingsBatch(taskId, ownedValues)
			for (const key of keys) {
				if (!previouslyOwned.has(key)) stateManager.clearTaskSetting(taskId, key)
			}
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Task settings persistence and rollback both failed")
		}
		throw error
	}
}

/** Update persisted task settings and, when addressed, the matching active Task snapshot. */
export async function updateTaskSettings(controller: Controller, request: UpdateTaskSettingsRequest): Promise<Empty> {
	if (controller.selectedGoalId && request.settings?.mode !== undefined) {
		throw new Error("Mode switching is disabled while a Goal is active.")
	}
	const taskId = resolveTaskId(controller, request)
	if (request.settings) {
		const activeTask = controller.task?.taskId === taskId ? controller.task : undefined
		const prepared = prepareTaskSettings(controller, request.settings, activeTask?.getWorkingConfiguration().settings)
		const taskPatch: TaskWorkingConfigurationPatch = { settings: prepared.settingsPatch }
		const persist = () => persistTaskSettings(controller, taskId, prepared)

		if (activeTask) await activeTask.applyWorkingConfigurationUpdate(taskPatch, persist)
		else persist()
	}
	await controller.postStateToWebview()
	return Empty.create()
}
