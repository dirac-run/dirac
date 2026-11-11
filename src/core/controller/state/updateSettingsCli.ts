import { prepareSandboxSettingsUpdate } from "@shared/SandboxSettings"
import { convertProtoToSubagentRoles } from "@shared/proto-conversions/subagent-roles"
import type { TaskWorkingConfiguration, TaskWorkingConfigurationPatch } from "@core/task/runtime/TaskWorkingConfiguration"
import type { ApiConfiguration } from "@shared/api"
import { Empty } from "@shared/proto/dirac/common"
import { Settings as ProtoSettings, UpdateSettingsRequestCli } from "@shared/proto/dirac/state"
import {
	convertProtoToApiProvider,
	convertProtoToModelProviderSelection,
} from "@shared/proto-conversions/models/api-configuration-conversion"
import type { Secrets, Settings } from "@shared/storage/state-keys"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { DiracEnv } from "@/config"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { commitWorkingConfigurationUpdate } from "../models/apiConfigurationTransaction"
import {
	applyDefaultTerminalProfileWithRollback,
	notifyTerminalProfileChange,
	type TerminalProfileChangeResult,
} from "./settingsTerminalProfile"
import { normalizeOpenaiReasoningEffort } from "./reasoningEffort"
import { filterSimpleSettingsBatch } from "./settingsCli"
import { convertPlanActMode } from "./settingsMode"
import { applyTelemetrySettingsCli } from "./settingsTelemetry"

interface CliSettingsPersistencePatch {
	globalSettings: Partial<Settings>
	sessionMode?: Settings["mode"]
}

/** Build all normalized CLI settings writes before entering the persistence transaction. */
function buildCliSettingsPersistencePatch(
	controller: Controller,
	settings: ProtoSettings,
	planModeApiProvider: ReturnType<typeof convertProtoToApiProvider> | undefined,
	actModeApiProvider: ReturnType<typeof convertProtoToApiProvider> | undefined,
): CliSettingsPersistencePatch {
	const {
		autoApprovalSettings,
		planModeReasoningEffort,
		actModeReasoningEffort,
		mode,
		customPrompt,
		planModeApiProvider: _planModeApiProvider,
		actModeApiProvider: _actModeApiProvider,
		telemetrySetting,
		yoloModeToggled,
		useAutoCondense,
		diracWebToolsEnabled,
		worktreesEnabled,
		subagentsEnabled,
		browserSettings,
		defaultTerminalProfile,
		utilityModelEnabled,
		utilityModelSelection,
		utilityModelUseCondense,
		utilityModelUseGenerateCommitMessage,
		utilityModelUsePermissionHandling,
		utilityModelPermissionPolicy,
		subagentRoles,
		sandboxSettings,
		...simpleSettings
	} = settings
	const globalSettings = filterSimpleSettingsBatch(simpleSettings)
	if (subagentRoles !== undefined) globalSettings.subagentRoles = convertProtoToSubagentRoles(subagentRoles)
	if (sandboxSettings !== undefined) globalSettings.sandboxSettings = prepareSandboxSettingsUpdate(controller.stateManager.getSystemDefaultSettingsKey("sandboxSettings"), sandboxSettings)

	Logger.log("autoApprovalSettings", controller.stateManager.getGlobalSettingsKey("autoApprovalSettings"))
	if (autoApprovalSettings) {
		globalSettings.autoApprovalSettings = mergeActiveAutoApprovalSettings(
			controller.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
			autoApprovalSettings,
		)
	}
	if (planModeReasoningEffort !== undefined) {
		globalSettings.planModeReasoningEffort = normalizeOpenaiReasoningEffort(planModeReasoningEffort)
	}
	if (actModeReasoningEffort !== undefined) {
		globalSettings.actModeReasoningEffort = normalizeOpenaiReasoningEffort(actModeReasoningEffort)
	}
	const sessionMode = mode === undefined ? undefined : convertPlanActMode(mode)
	if (sessionMode !== undefined) globalSettings.mode = sessionMode
	if (customPrompt === "compact") globalSettings.customPrompt = "compact"
	if (planModeApiProvider !== undefined) globalSettings.planModeApiProvider = planModeApiProvider
	if (actModeApiProvider !== undefined) globalSettings.actModeApiProvider = actModeApiProvider
	if (utilityModelEnabled !== undefined) globalSettings.utilityModelEnabled = utilityModelEnabled
	if (utilityModelSelection !== undefined) {
		globalSettings.utilityModelSelection = convertProtoToModelProviderSelection(utilityModelSelection)
	}
	if (utilityModelUseCondense !== undefined) globalSettings.utilityModelUseCondense = utilityModelUseCondense
	if (utilityModelUseGenerateCommitMessage !== undefined) {
		globalSettings.utilityModelUseGenerateCommitMessage = utilityModelUseGenerateCommitMessage
	}
	if (utilityModelUsePermissionHandling !== undefined) {
		globalSettings.utilityModelUsePermissionHandling = utilityModelUsePermissionHandling
	}
	if (utilityModelPermissionPolicy !== undefined) {
		globalSettings.utilityModelPermissionPolicy = utilityModelPermissionPolicy
	}
	if (telemetrySetting) globalSettings.telemetrySetting = telemetrySetting as TelemetrySetting
	if (yoloModeToggled !== undefined) globalSettings.yoloModeToggled = yoloModeToggled
	if (useAutoCondense !== undefined) globalSettings.useAutoCondense = useAutoCondense
	if (diracWebToolsEnabled !== undefined) globalSettings.diracWebToolsEnabled = diracWebToolsEnabled
	if (worktreesEnabled !== undefined) globalSettings.worktreesEnabled = worktreesEnabled
	if (subagentsEnabled !== undefined) globalSettings.subagentsEnabled = !!subagentsEnabled
	if (browserSettings) {
		globalSettings.browserSettings = mergeActiveBrowserSettings(
			controller.stateManager.getGlobalSettingsKey("browserSettings"),
			browserSettings,
		)
	}
	if (defaultTerminalProfile !== undefined && defaultTerminalProfile !== "") {
		globalSettings.defaultTerminalProfile = defaultTerminalProfile
	}

	return { globalSettings, sessionMode }
}

/** Apply addressed settings, secrets, and session mode with compensating rollback. */
function persistCliConfiguration(
	controller: Controller,
	patch: CliSettingsPersistencePatch,
	secrets: Partial<Secrets>,
	afterPersist?: () => void,
): void {
	const stateManager = controller.stateManager
	const globalKeys = Object.keys(patch.globalSettings) as Array<keyof Settings>
	const secretKeys = Object.keys(secrets) as Array<keyof Secrets>
	const previousGlobalSettings: Partial<Settings> = {}
	const previousSecrets: Partial<Secrets> = {}

	for (const key of globalKeys) {
		; (previousGlobalSettings as Record<string, unknown>)[key] = structuredClone(stateManager.getSystemDefaultSettingsKey(key))
	}
	for (const key of secretKeys) {
		; (previousSecrets as Record<string, unknown>)[key] = stateManager.getSecretKey(key)
	}

	const updatesSessionMode = patch.sessionMode !== undefined
	const hadSessionModeOverride = updatesSessionMode && stateManager.hasSessionOverride("mode")
	const previousSessionMode = hadSessionModeOverride ? stateManager.getGlobalSettingsKey("mode") : undefined

	try {
		if (globalKeys.length > 0) stateManager.setGlobalStateBatch(patch.globalSettings)
		if (secretKeys.length > 0) stateManager.setSecretsBatch(secrets)
		if (patch.sessionMode !== undefined) stateManager.setSessionOverride("mode", patch.sessionMode)
		afterPersist?.()
	} catch (error) {
		try {
			if (updatesSessionMode) {
				if (hadSessionModeOverride) stateManager.setSessionOverride("mode", previousSessionMode!)
				else stateManager.clearSessionOverride("mode")
			}
			if (secretKeys.length > 0) stateManager.setSecretsBatch(previousSecrets)
			if (globalKeys.length > 0) stateManager.setGlobalStateBatch(previousGlobalSettings)
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "CLI settings persistence and rollback both failed")
		}
		throw error
	}
}

function mergeActiveAutoApprovalSettings(
	current: TaskWorkingConfiguration["settings"]["autoApprovalSettings"],
	incoming: NonNullable<ProtoSettings["autoApprovalSettings"]>,
): Settings["autoApprovalSettings"] {
	const mutableCurrent = structuredClone(current) as Settings["autoApprovalSettings"]
	return {
		...mutableCurrent,
		...(incoming.version !== undefined && { version: incoming.version }),
		...(incoming.enableNotifications !== undefined && { enableNotifications: incoming.enableNotifications }),
		actions: {
			...mutableCurrent.actions,
			...(incoming.actions
				? Object.fromEntries(Object.entries(incoming.actions).filter(([, value]) => value !== undefined))
				: {}),
		},
	}
}

function mergeActiveBrowserSettings(
	current: TaskWorkingConfiguration["settings"]["browserSettings"],
	incoming: NonNullable<ProtoSettings["browserSettings"]>,
): Settings["browserSettings"] {
	return {
		...current,
		viewport: {
			width: incoming.viewport?.width || current.viewport.width,
			height: incoming.viewport?.height || current.viewport.height,
		},
		...(incoming.remoteBrowserEnabled !== undefined && { remoteBrowserEnabled: incoming.remoteBrowserEnabled }),
		...(incoming.remoteBrowserHost !== undefined && { remoteBrowserHost: incoming.remoteBrowserHost }),
		...(incoming.chromeExecutablePath !== undefined && { chromeExecutablePath: incoming.chromeExecutablePath }),
		...(incoming.disableToolUse !== undefined && { disableToolUse: incoming.disableToolUse }),
		...(incoming.customArgs !== undefined && { customArgs: incoming.customArgs }),
	}
}

/** Build exactly the normalized values intentionally applied to an existing CLI Task. */
function buildActiveTaskPatch(
	settings: ProtoSettings | undefined,
	secrets: Partial<Secrets>,
	planModeApiProvider: ReturnType<typeof convertProtoToApiProvider> | undefined,
	actModeApiProvider: ReturnType<typeof convertProtoToApiProvider> | undefined,
	workingConfiguration?: TaskWorkingConfiguration,
): TaskWorkingConfigurationPatch {
	const settingsPatch: Partial<Settings> = {}
	const apiConfiguration: Partial<ApiConfiguration> = { ...secrets }
	if (settings) {
		const {
			autoApprovalSettings,
			planModeReasoningEffort,
			actModeReasoningEffort,
			mode,
			customPrompt,
			planModeApiProvider: _planModeApiProvider,
			actModeApiProvider: _actModeApiProvider,
			telemetrySetting,
			yoloModeToggled,
			useAutoCondense,
			diracWebToolsEnabled,
			worktreesEnabled,
			subagentsEnabled,
			browserSettings,
			defaultTerminalProfile,
			utilityModelEnabled,
			utilityModelSelection,
			utilityModelUseCondense,
			utilityModelUseGenerateCommitMessage,
			utilityModelUsePermissionHandling,
			utilityModelPermissionPolicy,
			subagentRoles: _subagentRoles,
			sandboxSettings: _sandboxSettings,
			...simpleSettings
		} = settings

		Object.assign(settingsPatch, filterSimpleSettingsBatch(simpleSettings))
		// These values own constructor-created resources and remain defaults for a
		// future Task. Existing CLI behavior updates them through their explicit
		// resource paths rather than by replacing the Task working configuration.
		delete (settingsPatch as Record<string, unknown>).enableCheckpointsSetting
		delete (settingsPatch as Record<string, unknown>).shellIntegrationTimeout
		delete (settingsPatch as Record<string, unknown>).terminalOutputLineLimit

		if (workingConfiguration && autoApprovalSettings) {
			settingsPatch.autoApprovalSettings = mergeActiveAutoApprovalSettings(
				workingConfiguration.settings.autoApprovalSettings,
				autoApprovalSettings,
			)
		}
		if (planModeReasoningEffort !== undefined)
			settingsPatch.planModeReasoningEffort = normalizeOpenaiReasoningEffort(planModeReasoningEffort)
		if (actModeReasoningEffort !== undefined)
			settingsPatch.actModeReasoningEffort = normalizeOpenaiReasoningEffort(actModeReasoningEffort)
		if (mode !== undefined) settingsPatch.mode = convertPlanActMode(mode)
		if (customPrompt === "compact") settingsPatch.customPrompt = "compact"
		if (planModeApiProvider !== undefined) settingsPatch.planModeApiProvider = planModeApiProvider
		if (actModeApiProvider !== undefined) settingsPatch.actModeApiProvider = actModeApiProvider
		if (telemetrySetting !== undefined) settingsPatch.telemetrySetting = telemetrySetting as TelemetrySetting
		if (yoloModeToggled !== undefined) settingsPatch.yoloModeToggled = yoloModeToggled
		if (useAutoCondense !== undefined) settingsPatch.useAutoCondense = useAutoCondense
		if (diracWebToolsEnabled !== undefined) settingsPatch.diracWebToolsEnabled = diracWebToolsEnabled
		if (worktreesEnabled !== undefined) settingsPatch.worktreesEnabled = worktreesEnabled
		if (subagentsEnabled !== undefined) settingsPatch.subagentsEnabled = subagentsEnabled
		if (workingConfiguration && browserSettings)
			settingsPatch.browserSettings = mergeActiveBrowserSettings(
				workingConfiguration.settings.browserSettings,
				browserSettings,
			)
		if (defaultTerminalProfile !== undefined && defaultTerminalProfile !== "")
			settingsPatch.defaultTerminalProfile = defaultTerminalProfile
		if (utilityModelEnabled !== undefined) settingsPatch.utilityModelEnabled = utilityModelEnabled
		if (utilityModelSelection !== undefined)
			settingsPatch.utilityModelSelection = convertProtoToModelProviderSelection(utilityModelSelection)
		if (utilityModelUseCondense !== undefined) settingsPatch.utilityModelUseCondense = utilityModelUseCondense
		if (utilityModelUseGenerateCommitMessage !== undefined)
			settingsPatch.utilityModelUseGenerateCommitMessage = utilityModelUseGenerateCommitMessage
		if (utilityModelUsePermissionHandling !== undefined)
			settingsPatch.utilityModelUsePermissionHandling = utilityModelUsePermissionHandling
		if (utilityModelPermissionPolicy !== undefined) settingsPatch.utilityModelPermissionPolicy = utilityModelPermissionPolicy
	}

	return { settings: settingsPatch, apiConfiguration }
}

/** Update CLI defaults and explicitly transition the active Task using the same normalized values. */
export async function updateSettingsCli(controller: Controller, request: UpdateSettingsRequestCli): Promise<Empty> {
	const settings = request.settings
	if (controller.selectedGoalId && settings?.mode !== undefined) {
		throw new Error("Mode switching is disabled while a Goal is active.")
	}
	const secrets: Partial<Secrets> = request.secrets
		? Object.fromEntries(Object.entries(request.secrets).filter(([, value]) => value !== undefined))
		: {}
	const planModeApiProvider =
		settings?.planModeApiProvider === undefined ? undefined : convertProtoToApiProvider(settings.planModeApiProvider)
	const actModeApiProvider =
		settings?.actModeApiProvider === undefined ? undefined : convertProtoToApiProvider(settings.actModeApiProvider)

	if (
		settings?.defaultTerminalProfile !== undefined &&
		settings.defaultTerminalProfile !== "" &&
		controller.task &&
		!controller.task.terminalManager
	) {
		throw new Error("Cannot update terminal profile: Terminal manager missing from active task")
	}

	let previousActiveTerminalProfile: string | undefined
	const addressedPatch = buildActiveTaskPatch(settings, secrets, planModeApiProvider, actModeApiProvider)
	const addressesActiveTask = Object.keys(addressedPatch.settings ?? {}).length > 0 ||
		Object.keys(addressedPatch.apiConfiguration ?? {}).length > 0 ||
		settings?.autoApprovalSettings !== undefined || settings?.browserSettings !== undefined
	const taskPatch = controller.task && addressesActiveTask
		? (current: TaskWorkingConfiguration) => {
			previousActiveTerminalProfile = current.settings.defaultTerminalProfile
			return buildActiveTaskPatch(settings, secrets, planModeApiProvider, actModeApiProvider, current)
		}
		: undefined
	let terminalProfileChange: TerminalProfileChangeResult | undefined
	const persist = () => {
		const persistencePatch = settings
			? buildCliSettingsPersistencePatch(controller, settings, planModeApiProvider, actModeApiProvider)
			: { globalSettings: {} }
		persistCliConfiguration(controller, persistencePatch, secrets, () => {
			if (settings?.defaultTerminalProfile === undefined || settings.defaultTerminalProfile === "") return
			terminalProfileChange = applyDefaultTerminalProfileWithRollback(
				controller,
				settings.defaultTerminalProfile,
				previousActiveTerminalProfile,
			)
		})
	}

	await commitWorkingConfigurationUpdate(controller, persist, taskPatch)
	if (terminalProfileChange) {
		notifyTerminalProfileChange(terminalProfileChange.closedCount, terminalProfileChange.busyTerminals?.length ?? 0)
	}

	if (request.environment !== undefined) DiracEnv.setEnvironment(request.environment)
	if (settings?.telemetrySetting) await controller.updateTelemetrySetting(settings.telemetrySetting as TelemetrySetting)
	if (settings) {
		applyTelemetrySettingsCli(controller, {
			yoloModeToggled: settings.yoloModeToggled,
			useAutoCondense: settings.useAutoCondense,
			diracWebToolsEnabled: settings.diracWebToolsEnabled,
			worktreesEnabled: undefined,
			subagentsEnabled: settings.subagentsEnabled,
		})
	}
	await controller.postStateToWebview()
	return Empty.create()
}
