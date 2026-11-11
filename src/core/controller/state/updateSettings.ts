import { prepareSandboxSettingsUpdate } from "@shared/SandboxSettings"
import type { ApiConfiguration } from "@shared/api"
import { Empty } from "@shared/proto/dirac/common"
import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { convertProtoToApiConfiguration } from "@shared/proto-conversions/models/api-configuration-conversion"
import type { GlobalStateAndSettings, Settings } from "@shared/storage/state-keys"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { DiracEnv } from "@/config"
import { Logger } from "@/shared/services/Logger"
import { ToolRegistry } from "@core/task/tools/registry/ToolRegistry"
import type { TaskWorkingConfiguration, TaskWorkingConfigurationPatch } from "@core/task/runtime/TaskWorkingConfiguration"
import { validateApiConfiguration } from "@core/api"
import { telemetryService } from "@services/telemetry"
import { Controller } from ".."
import { persistApiConfigurationAndMode } from "../models/apiConfigurationPersistence"
import { commitWorkingConfigurationUpdate } from "../models/apiConfigurationTransaction"
import { buildBrowserSettingsWebview } from "./settingsBrowser"
import { convertMode } from "./settingsMode"
import {
	applyDefaultTerminalProfileWithRollback,
	notifyTerminalProfileChange,
	type TerminalProfileChangeResult,
} from "./settingsTerminalProfile"
import { buildWebviewSettingsPatch } from "./settingsWebview"

function capturePersistedSettings(
	controller: Controller,
	patch: Partial<GlobalStateAndSettings>,
): Partial<GlobalStateAndSettings> {
	return Object.fromEntries(
		Object.keys(patch).map((key) => [
			key,
			structuredClone(
				key === "terminalReuseEnabled" || key === "multiRootEnabled" || key === "vscodeTerminalExecutionMode"
					? controller.stateManager.getGlobalStateKey(key)
					: controller.stateManager.getSystemDefaultSettingsKey(key as keyof Settings),
			),
		]),
	) as Partial<GlobalStateAndSettings>
}

function restoreSettingsPersistence(
	controller: Controller,
	previous: Partial<GlobalStateAndSettings>,
	registry?: ToolRegistry,
	previousRegistryToggles?: Record<string, boolean>,
): void {
	if (previousRegistryToggles && registry) registry.loadToggles(previousRegistryToggles)
	for (const [key, value] of Object.entries(previous))
		controller.stateManager.setGlobalState(key as keyof GlobalStateAndSettings, value as never)
}

function persistCombinedWebviewUpdate(
	controller: Controller,
	settingsPatch: Partial<GlobalStateAndSettings>,
	previousSettings: Partial<GlobalStateAndSettings>,
	apiConfiguration: ApiConfiguration | undefined,
	mode: ReturnType<typeof convertMode>,
	previousActiveTerminalProfile: string | undefined,
	registry?: ToolRegistry,
	previousRegistryToggles?: Record<string, boolean>,
): TerminalProfileChangeResult | undefined {
	let terminalProfileChange: TerminalProfileChangeResult | undefined
	if (settingsPatch.sandboxSettings !== undefined) settingsPatch.sandboxSettings = prepareSandboxSettingsUpdate(previousSettings.sandboxSettings, settingsPatch.sandboxSettings)
	try {
		if (settingsPatch.toolToggles && registry) registry.loadToggles(settingsPatch.toolToggles)
		for (const [key, value] of Object.entries(settingsPatch))
			controller.stateManager.setGlobalState(key as keyof GlobalStateAndSettings, value as never)
		persistApiConfigurationAndMode(controller.stateManager, apiConfiguration ?? {}, mode, () => {
			if (settingsPatch.defaultTerminalProfile === undefined) return
			terminalProfileChange = applyDefaultTerminalProfileWithRollback(
				controller,
				settingsPatch.defaultTerminalProfile,
				previousActiveTerminalProfile,
			)
		})
		return terminalProfileChange
	} catch (error) {
		try {
			restoreSettingsPersistence(controller, previousSettings, registry, previousRegistryToggles)
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Webview settings persistence and rollback both failed")
		}
		throw error
	}
}

function buildCombinedWebviewPatches(
	controller: Controller,
	request: UpdateSettingsRequest,
	activeConfiguration?: TaskWorkingConfiguration,
	normalizedToolToggles?: Record<string, boolean>,
): {
	persistedSettings: Partial<GlobalStateAndSettings>
	activePatch: TaskWorkingConfigurationPatch
	apiConfiguration?: ApiConfiguration
	mode: ReturnType<typeof convertMode>
} {
	const persistedSettings = buildWebviewSettingsPatch(request)
	const persistedExecutionOptions: Partial<GlobalStateAndSettings> = {
		...(request.terminalReuseEnabled === undefined ? {} : { terminalReuseEnabled: request.terminalReuseEnabled }),
		...(request.multiRootEnabled === undefined ? {} : { multiRootEnabled: !!request.multiRootEnabled }),
		...(request.vscodeTerminalExecutionMode === undefined || request.vscodeTerminalExecutionMode === ""
			? {}
			: {
				vscodeTerminalExecutionMode:
					request.vscodeTerminalExecutionMode === "backgroundExec" ? "backgroundExec" : "vscodeTerminal",
			}),
	}
	if (request.browserSettings !== undefined) {
		persistedSettings.browserSettings = buildBrowserSettingsWebview(
			controller.stateManager.getGlobalSettingsKey("browserSettings"),
			request,
		)
	}
	if (request.defaultTerminalProfile !== undefined) persistedSettings.defaultTerminalProfile = request.defaultTerminalProfile
	if (normalizedToolToggles !== undefined) persistedSettings.toolToggles = normalizedToolToggles

	const activeSettings: Partial<Settings> = { ...persistedSettings }
	delete activeSettings.subagentRoles
	delete activeSettings.sandboxSettings
	if (request.browserSettings !== undefined && activeConfiguration) {
		activeSettings.browserSettings = buildBrowserSettingsWebview(
			activeConfiguration.settings.browserSettings as Settings["browserSettings"],
			request,
		)
	}
	// These values configure constructor-owned resources and historically did not
	// reconfigure an existing terminal manager through this endpoint.
	delete activeSettings.shellIntegrationTimeout
	delete activeSettings.terminalOutputLineLimit

	const mode = convertMode(request.mode)
	if (mode !== undefined) activeSettings.mode = mode
	const apiConfiguration = request.apiConfiguration ? convertProtoToApiConfiguration(request.apiConfiguration) : undefined
	return {
		persistedSettings: { ...persistedSettings, ...persistedExecutionOptions },
		activePatch: {
			...(Object.keys(activeSettings).length > 0 ? { settings: activeSettings } : {}),
			...(apiConfiguration ? { apiConfiguration } : {}),
		},
		apiConfiguration,
		mode,
	}
}

async function normalizeRequestedToolToggles(request: UpdateSettingsRequest): Promise<Record<string, boolean> | undefined> {
	if (request.toolToggles === undefined) return undefined
	const requestedToggles = JSON.parse(request.toolToggles) as Record<string, boolean>
	return ToolRegistry.withExclusiveAccess((registry) => {
		const previousToggles = registry.getToggles()
		try {
			registry.loadToggles(requestedToggles)
			return registry.getToggles()
		} finally {
			registry.loadToggles(previousToggles)
		}
	})
}

function requestAddressesActiveTask(
	request: UpdateSettingsRequest,
	normalizedToolToggles: Record<string, boolean> | undefined,
): boolean {
	const activeSettings = buildWebviewSettingsPatch(request)
	delete activeSettings.subagentRoles
	delete activeSettings.sandboxSettings
	delete activeSettings.shellIntegrationTimeout
	delete activeSettings.terminalOutputLineLimit
	return (
		Object.keys(activeSettings).length > 0 ||
		request.browserSettings !== undefined ||
		request.defaultTerminalProfile !== undefined ||
		normalizedToolToggles !== undefined ||
		convertMode(request.mode) !== undefined ||
		request.apiConfiguration !== undefined
	)
}

async function commitWebviewSettings(
	controller: Controller,
	request: UpdateSettingsRequest,
): Promise<TerminalProfileChangeResult | undefined> {
	if (request.apiConfiguration && !controller.task) {
		const configuration = convertProtoToApiConfiguration(request.apiConfiguration)
		validateApiConfiguration(configuration, convertMode(request.mode) ?? controller.stateManager.getGlobalSettingsKey("mode"))
	}

	const normalizedToolToggles = await normalizeRequestedToolToggles(request)
	let preparedUpdate: ReturnType<typeof buildCombinedWebviewPatches> | undefined
	let previousActiveTerminalProfile: string | undefined
	const activeTaskPatch =
		controller.task && requestAddressesActiveTask(request, normalizedToolToggles)
			? (current: TaskWorkingConfiguration) => {
				previousActiveTerminalProfile = current.settings.defaultTerminalProfile
				preparedUpdate = buildCombinedWebviewPatches(controller, request, current, normalizedToolToggles)
				return preparedUpdate.activePatch
			}
			: undefined
	let terminalProfileChange: TerminalProfileChangeResult | undefined
	const persist = async () => {
		const update = preparedUpdate ?? buildCombinedWebviewPatches(controller, request, undefined, normalizedToolToggles)
		const previousSettings = capturePersistedSettings(controller, update.persistedSettings)
		const persistUpdate = (registry?: ToolRegistry, previousRegistryToggles?: Record<string, boolean>) => {
			terminalProfileChange = persistCombinedWebviewUpdate(
				controller,
				update.persistedSettings,
				previousSettings,
				update.apiConfiguration,
				update.mode,
				previousActiveTerminalProfile,
				registry,
				previousRegistryToggles,
			)
		}
		if (normalizedToolToggles === undefined) {
			persistUpdate()
			return
		}
		await ToolRegistry.withExclusiveAccess((registry) => persistUpdate(registry, registry.getToggles()))
	}

	await commitWorkingConfigurationUpdate(controller, persist, activeTaskPatch)
	return terminalProfileChange
}

function publishSettingTelemetry(
	controller: Controller,
	request: UpdateSettingsRequest,
	previousActiveSettings: Readonly<Partial<Settings>>,
): void {
	const task = controller.task
	if (request.yoloModeToggled !== undefined && task) telemetryService.captureYoloModeToggle(task.ulid, request.yoloModeToggled)
	if (request.diracWebToolsEnabled !== undefined && task)
		telemetryService.captureDiracWebToolsToggle(task.ulid, request.diracWebToolsEnabled)
	if (request.subagentsEnabled !== undefined && previousActiveSettings.subagentsEnabled !== !!request.subagentsEnabled)
		telemetryService.captureSubagentToggle(!!request.subagentsEnabled)
	if (request.useAutoCondense !== undefined && task)
		telemetryService.captureAutoCondenseToggle(task.ulid, request.useAutoCondense, task.api.getModel().id)
	if (request.hooksEnabled !== undefined && task && previousActiveSettings.hooksEnabled !== !!request.hooksEnabled)
		telemetryService.captureFeatureToggle(task.ulid, "hooks", !!request.hooksEnabled, task.api.getModel().id)
}

/** Update webview settings while keeping persisted defaults and an active Task in one explicit transition. */
export async function updateSettings(controller: Controller, request: UpdateSettingsRequest): Promise<Empty> {
	try {
		if (controller.selectedGoalId && convertMode(request.mode) !== undefined) {
			throw new Error("Mode switching is disabled while a Goal is active.")
		}
		const previousActiveSettings = structuredClone(
			controller.task?.getWorkingConfiguration().settings ?? {
				hooksEnabled: controller.stateManager.getGlobalSettingsKey("hooksEnabled") ?? true,
				subagentsEnabled: controller.stateManager.getGlobalSettingsKey("subagentsEnabled") ?? false,
			},
		) as Partial<Settings>

		if (request.diracEnv !== undefined) DiracEnv.setEnvironment(request.diracEnv)
		const terminalProfileChange = await commitWebviewSettings(controller, request)
		if (terminalProfileChange) {
			notifyTerminalProfileChange(terminalProfileChange.closedCount, terminalProfileChange.busyTerminals?.length ?? 0)
		}
		if (request.telemetrySetting) await controller.updateTelemetrySetting(request.telemetrySetting as TelemetrySetting)

		publishSettingTelemetry(controller, request, previousActiveSettings)
		await controller.postStateToWebview()
		return Empty.create()
	} catch (error) {
		Logger.error("Failed to update settings:", error)
		throw error
	}
}
