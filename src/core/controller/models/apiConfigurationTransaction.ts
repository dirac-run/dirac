import { validateApiConfiguration } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import type { TaskWorkingConfiguration, TaskWorkingConfigurationPatch } from "@core/task/runtime/TaskWorkingConfiguration"
import { ALL_PROVIDERS, type ApiConfiguration, type ApiProvider } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { isProviderSetupField } from "@shared/providerSetupFields"
import { persistApiConfigurationPatch, persistProviderSetupPatch } from "./apiConfigurationPersistence"

export type ActiveTaskWorkingConfigurationUpdate =
	| TaskWorkingConfigurationPatch
	| ((current: TaskWorkingConfiguration) => TaskWorkingConfigurationPatch)

export type ApiConfigurationTransactionTask = {
	getWorkingConfiguration(): TaskWorkingConfiguration
	applyWorkingConfigurationUpdate(
		patch: ActiveTaskWorkingConfigurationUpdate,
		beforeCommit?: (candidate: TaskWorkingConfiguration) => void | Promise<void>,
	): Promise<TaskWorkingConfiguration>
}

export type ApiConfigurationTransactionContext = {
	stateManager: StateManager
	task?: ApiConfigurationTransactionTask
}

export type ApiConfigurationPersistence = () => void | Promise<void>

/**
 * Persist an explicit update at the Task's validated commit boundary.
 *
 * For an active Task, candidate construction and API-handler validation happen
 * before `persist`, while the Task transition lock is held. A persistence
 * failure therefore leaves the Task snapshot and runtime unchanged. Once
 * `persist` resolves, the remaining Task commit is synchronous and non-fallible.
 */
export async function commitWorkingConfigurationUpdate(
	controller: ApiConfigurationTransactionContext,
	persist: ApiConfigurationPersistence,
	activeTaskPatch?: ActiveTaskWorkingConfigurationUpdate,
): Promise<void> {
	if (controller.task && activeTaskPatch) {
		await controller.task.applyWorkingConfigurationUpdate(activeTaskPatch, persist)
		return
	}
	await persist()
}

/**
 * Validate, persist, and install an API configuration in release-safe order.
 *
 * `activeConfigurationPatch` contains only fields explicitly addressed by the
 * operation. The complete `configuration` remains the persistence candidate
 * and validates default-only updates when no active Task owns a snapshot.
 */
export async function applyApiConfigurationTransaction(
	controller: ApiConfigurationTransactionContext,
	configuration: ApiConfiguration,
	persist: ApiConfigurationPersistence = () => persistApiConfigurationPatch(controller.stateManager, configuration),
	mode?: Mode,
	activeConfigurationPatch: Partial<ApiConfiguration> = configuration,
): Promise<void> {
	const activeTaskPatch: TaskWorkingConfigurationPatch = {
		apiConfiguration: activeConfigurationPatch,
		...(mode === undefined ? {} : { settings: { mode } }),
	}

	if (!controller.task) {
		validateApiConfiguration(configuration, mode ?? controller.stateManager.getGlobalSettingsKey("mode"))
	} else {
		const current = controller.task.getWorkingConfiguration()
		validateApiConfiguration(
			{ ...current.apiConfiguration, ...activeConfigurationPatch } as ApiConfiguration,
			mode ?? current.settings.mode,
		)
	}

	await commitWorkingConfigurationUpdate(controller, persist, controller.task ? activeTaskPatch : undefined)
}

/** Save access/setup without activating a provider or requiring an initial model. */
export async function applyProviderSetupTransaction(
	controller: ApiConfigurationTransactionContext,
	setupPatch: Partial<ApiConfiguration>,
	persist?: ApiConfigurationPersistence,
	setupProvider?: ApiProvider,
): Promise<void> {
	if (setupProvider !== undefined && !ALL_PROVIDERS.includes(setupProvider)) {
		throw new Error(`Unknown setup provider: ${setupProvider}`)
	}
	for (const field of Object.keys(setupPatch)) {
		if (!isProviderSetupField(field)) {
			throw new Error(`Provider setup cannot update execution selection or unsupported field: ${field}`)
		}
	}
	if (setupPatch.openAiCompatibleProfiles) {
		const names = new Set<string>()
		for (const profile of setupPatch.openAiCompatibleProfiles) {
			if (!profile.name.trim() || names.has(profile.name)) {
				throw new Error("OpenAI-compatible endpoint names must be non-empty and unique")
			}
			names.add(profile.name)
		}
	}
	// A live Task must receive fresh setup for Utility and future children. Its
	// existing boundary validates/builds the unchanged selection before persistence.
	// Without a Task, access can be saved before any application model is selected.
	await commitWorkingConfigurationUpdate(
		controller,
		persist ?? (() => persistProviderSetupPatch(controller.stateManager, setupPatch, setupProvider)),
		Object.keys(setupPatch).length > 0 ? { apiConfiguration: setupPatch } : undefined,
	)
}
