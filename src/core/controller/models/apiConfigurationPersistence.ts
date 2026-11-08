import type { StateManager } from "@core/storage/StateManager"
import type { ApiConfiguration, ApiProvider } from "@shared/api"
import { isSecretKey, isSettingsKey } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"

interface PersistenceSnapshot {
	apiConfiguration: Partial<ApiConfiguration>
	hadSessionMode: boolean
	globalMode?: Mode
	sessionMode?: Mode
}

function capturePersistenceSnapshot(
	stateManager: StateManager,
	configurationPatch: Partial<ApiConfiguration>,
	mode: Mode | undefined,
): PersistenceSnapshot {
	const previousConfiguration: Partial<ApiConfiguration> = {}
	for (const key of Object.keys(configurationPatch).filter(isSettingsKey)) {
		; (previousConfiguration as Record<string, unknown>)[key] = structuredClone(stateManager.getSystemDefaultSettingsKey(key))
	}
	for (const key of Object.keys(configurationPatch).filter(isSecretKey)) {
		; (previousConfiguration as Record<string, unknown>)[key] = stateManager.getSecretKey(key)
	}
	const hadSessionMode = mode !== undefined && stateManager.hasSessionOverride("mode")
	return {
		apiConfiguration: previousConfiguration,
		hadSessionMode,
		globalMode: mode === undefined ? undefined : stateManager.getSystemDefaultSettingsKey("mode"),
		sessionMode: hadSessionMode ? stateManager.getGlobalSettingsKey("mode") : undefined,
	}
}

function restorePersistenceSnapshot(
	stateManager: StateManager,
	snapshot: PersistenceSnapshot,
	hadApiUpdate: boolean,
	hadModeUpdate: boolean,
): void {
	if (hadModeUpdate) {
		if (snapshot.hadSessionMode) stateManager.setSessionOverride("mode", snapshot.sessionMode!)
		else stateManager.clearSessionOverride("mode")
		stateManager.setGlobalState("mode", snapshot.globalMode!)
	}
	if (hadApiUpdate) stateManager.setApiConfiguration(snapshot.apiConfiguration as ApiConfiguration)
}

/** Persist addressed API fields and optional mode as one compensated state transition. */
export function persistApiConfigurationAndMode(
	stateManager: StateManager,
	configurationPatch: Partial<ApiConfiguration>,
	mode?: Mode,
	afterPersist?: () => void,
): void {
	const hadApiUpdate = Object.keys(configurationPatch).length > 0
	const hadModeUpdate = mode !== undefined
	const snapshot = capturePersistenceSnapshot(stateManager, configurationPatch, mode)

	try {
		if (hadApiUpdate) stateManager.setApiConfiguration(configurationPatch as ApiConfiguration)
		if (mode !== undefined) {
			stateManager.setGlobalState("mode", mode)
			stateManager.setSessionOverride("mode", mode)
		}
		afterPersist?.()
	} catch (error) {
		try {
			restorePersistenceSnapshot(stateManager, snapshot, hadApiUpdate, hadModeUpdate)
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "API and mode persistence rollback failed")
		}
		throw error
	}
}

/** Persist exactly the addressed API fields and compensate if the write fails. */
export function persistApiConfigurationPatch(stateManager: StateManager, configurationPatch: Partial<ApiConfiguration>): void {
	persistApiConfigurationAndMode(stateManager, configurationPatch)
}

/** Provider membership and addressed setup are one compensated persistence operation. */
export function persistProviderSetupPatch(
	stateManager: StateManager,
	setupPatch: Partial<ApiConfiguration>,
	provider?: ApiProvider,
): void {
	if (provider === undefined) {
		persistApiConfigurationPatch(stateManager, setupPatch)
		return
	}
	const previous = stateManager.getSystemDefaultSettingsKey("addedApiProviders")
	let membershipWriteStarted = false
	try {
		persistApiConfigurationAndMode(stateManager, setupPatch, undefined, () => {
			if (previous.includes(provider)) return
			membershipWriteStarted = true
			stateManager.setGlobalState("addedApiProviders", [...previous, provider])
		})
	} catch (error) {
		if (membershipWriteStarted) {
			try {
				stateManager.setGlobalState("addedApiProviders", previous)
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Provider setup membership rollback failed")
			}
		}
		throw error
	}
}
