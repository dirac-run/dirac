import type { Settings } from "@shared/storage/state-keys"
import { StateManager } from "@/core/storage/StateManager"

/**
 * Atomically replace the entire session-override cache in StateManager and
 * return the previous contents.
 *
 * Used by the ACP layer to implement per-session override scoping: before
 * a session's prompt begins, call this with that session's overrides to
 * install them; in the finally block, call it again with the saved snapshot
 * to restore the previous state (typically the CLI's global overrides, e.g.
 * --auto-approve-all).
 *
 * Never persisted to disk.
 */
export function swapSessionOverrides(overrides: Partial<Settings>): Partial<Settings> {
	const sm = StateManager.get()
	const previous = sm.getSessionOverrideCache()
	sm.setSessionOverrideCache({ ...overrides })
	return previous
}
