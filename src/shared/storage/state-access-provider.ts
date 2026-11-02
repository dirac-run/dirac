import type { StateAccess } from "./state-access"

// Leaf layers (services/integrations) must not import core's StateManager; this seam is
// registered by core at StateManager.initialize() and resolved lazily by leaves.
let provider: (() => StateAccess | undefined) | undefined

export function initializeStateAccess(stateProvider: () => StateAccess | undefined): void {
	provider = stateProvider
}

/** Returns state access when the host has initialized storage, else undefined. */
export function getStateAccess(): StateAccess | undefined {
	return provider?.()
}

/** Returns state access or throws when storage is not initialized — same contract as StateManager.get(). */
export function requireStateAccess(): StateAccess {
	const state = getStateAccess()
	if (!state) throw new Error("State access is not initialized")
	return state
}

/** Test seam — clears the registered provider. */
export function resetStateAccess(): void {
	provider = undefined
}
