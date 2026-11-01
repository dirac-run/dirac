import { releaseFolderLock, tryAcquireFolderLockWithRetry } from "@/core/locks/FolderLockUtils"
import type { FolderLockOptions, FolderLockWithRetryResult } from "@/core/locks/types"

/**
 * Base path for checkpoint folders
 */
const CHECKPOINTS_BASE_PATH = "~/.dirac/data/checkpoints"

// Folder leases exclude other instances, not siblings within this process.
const repositoryTails = new Map<string, Promise<void>>()

/** Lock order: repository critical section, existing folder lease, nested-Git mutation lock.
 * Call only at checkpoint operation boundaries, never recursively from Git helpers.
 * This protects shared Git state; it does not drain tasks or serialize workspace edits.
 */
export async function withCheckpointRepositoryLock<T>(gitPath: string, operation: () => Promise<T>): Promise<T> {
	const previous = repositoryTails.get(gitPath) ?? Promise.resolve()
	let release!: () => void
	const pending = new Promise<void>((resolve) => { release = resolve })
	const tail = previous.then(() => pending)
	repositoryTails.set(gitPath, tail)
	await previous
	try {
		return await operation()
	} finally {
		release()
		if (repositoryTails.get(gitPath) === tail) repositoryTails.delete(gitPath)
	}
}

/**
 * Attempt to acquire checkpoint folder lock with retry logic.
 * This is a convenience wrapper around the generic folder lock utility
 * that automatically derives the correct folder path from the cwdHash.
 *
 * @param cwdHash - The hash of the working directory
 * @param taskId - The task ID (swapped to instance address in SqliteLockManager)
 * @returns Promise<FolderLockWithRetryResult> with acquisition status and any conflicting lock info
 */
export async function tryAcquireCheckpointLockWithRetry(cwdHash: string, taskId: string): Promise<FolderLockWithRetryResult> {
	const options: FolderLockOptions = {
		lockTarget: `${CHECKPOINTS_BASE_PATH}/${cwdHash}`,
		heldBy: taskId,
	}

	const result = await tryAcquireFolderLockWithRetry(options)
	return { acquired: result.acquired, skipped: result.skipped, conflictingLock: result.conflictingLock }
}

/**
 * Release checkpoint folder lock safely.
 * This is a convenience wrapper around the generic folder lock utility
 * that automatically derives the correct folder path from the cwdHash.
 *
 * @param cwdHash - The hash of the working directory
 */
export async function releaseCheckpointLock(cwdHash: string, taskId: string): Promise<void> {
	await releaseFolderLock(taskId, `${CHECKPOINTS_BASE_PATH}/${cwdHash}`)
}
