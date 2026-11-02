import type { ApiConfiguration } from "@shared/api"
import type { GlobalState, GlobalStateAndSettings, LocalState, Secrets, Settings } from "./state-keys"

/**
 * Narrow read/write access to persisted state for leaf layers (services, integrations).
 * `StateManager` satisfies this structurally — core injects it; leaves never import the singleton.
 */
export interface StateAccess {
	getGlobalStateKey<K extends keyof GlobalState>(key: K): GlobalState[K]
	getGlobalSettingsKey<K extends keyof Settings>(key: K): Settings[K]
	getWorkspaceStateKey<K extends keyof LocalState>(key: K): LocalState[K]
	getWorkspaceStateKey(key: string): unknown
	getSecretKey<K extends keyof Secrets>(key: K): Secrets[K]
	setGlobalState<K extends keyof GlobalStateAndSettings>(key: K, value: GlobalStateAndSettings[K]): void
	setGlobalStateBatch(updates: Partial<GlobalStateAndSettings>): void
	setSecret<K extends keyof Secrets>(key: K, value: Secrets[K]): void
	getApiConfiguration(): ApiConfiguration
	flushPendingState(): Promise<void>
}
