import type { ICheckpointManager } from "@integrations/checkpoints/types"

/**
 * Ensures a checkpoint manager is initialized, handling both single-root and multi-root implementations.
 * - TaskCheckpointManager exposes `checkpointTrackerCheckAndInit()`
 * - MultiRootCheckpointManager exposes `initialize()`
 */
export async function ensureCheckpointInitialized({
	checkpointManager,
}: {
	checkpointManager: ICheckpointManager | undefined
}): Promise<void> {
	if (!checkpointManager) {
		return
	}
	// TaskCheckpointManager path
	const maybeInit = checkpointManager.checkpointTrackerCheckAndInit
	if (typeof maybeInit === "function") {
		await maybeInit.call(checkpointManager)
		return
	}

	// MultiRootCheckpointManager path
	const maybeInitialize = checkpointManager.initialize
	if (typeof maybeInitialize === "function") {
		await maybeInitialize.call(checkpointManager)
	}
}
