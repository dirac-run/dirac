/**
 * One-time migration from VSCode's ExtensionContext storage to file-backed stores.
 *
 * VSCode historically stored global state, workspace state, and secrets via the
 * ExtensionContext API (backed by SQLite under ~/.vscode/). This module migrates
 * that data to the shared file-backed stores in ~/.dirac/data/ so all platforms
 * (VSCode, CLI, JetBrains) share the same persistence layer.
 *
 * ## Migration semantics
 *
 * - **Two independent sentinels** control migration:
 *   - `__migrationVersion` in the file-backed `globalState` gates global state + secrets.
 *   - `__migrationVersion` in the file-backed `workspaceState` gates per-workspace state.
 *   This ensures that when a new workspace is opened for the first time, its workspace
 *   state is still migrated even though globals+secrets were already exported previously.
 *
 * - **Merge strategy: file-backed store wins.** If a key already exists in the
 *   file store (e.g. because CLI or JetBrains wrote it), we do NOT overwrite.
 *   This prevents the migration from clobbering newer data written by another client.
 *
 * - VSCode storage is NOT cleared after migration. This ensures safe downgrade:
 *   if the user rolls back to an older extension version that doesn't know about
 *   file-backed stores, the old code path still works.
 *
 * - taskHistory is NOT migrated here. It uses its own file-based storage
 *   at {globalStorageFsPath}/state/taskHistory.json. Note that for VSCode,
 *   globalStorageFsPath is still the VSCode-managed path (not ~/.dirac/data/),
 *   so task history is NOT yet shared across clients.
 *
 *   TODO: Migrate taskHistory.json and task data files ({globalStorageFsPath}/tasks/)
 *   to ~/.dirac/data/ so that tasks created in VSCode are visible in CLI/JetBrains
 *   and vice versa. See also: checkpoints at {globalStorageFsPath}/checkpoints/.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { fileExistsAtPath } from "@/utils/fs"
import { HistoryItem } from "@/shared/HistoryItem"

import type * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { GlobalStateAndSettingKeys, LocalStateKeys, SecretKeys } from "@/shared/storage/state-keys"
import type { StorageContext } from "@/shared/storage/storage-context"

/** Bump this when adding new migration steps. */
const CURRENT_MIGRATION_VERSION = 2

/** Sentinel key written to both globalState and workspaceState to track migration independently. */
const MIGRATION_VERSION_KEY = "__vscodeMigrationVersion"

/**
 * Keys that should NOT be migrated from VSCode storage.
 * These are either:
 * - async/computed (taskHistory has its own file)
 * - ephemeral/transient
 */
const SKIP_GLOBAL_STATE_KEYS = new Set<string>([
	"taskHistory", // Already file-based in tasks/taskHistory.json
])

export interface MigrationResult {
	migrated: boolean
	globalStateCount: number
	secretsCount: number
	workspaceStateCount: number
	skippedExisting: number
}

/**
 * Run the one-time migration from VSCode ExtensionContext storage to file-backed stores.
 *
 * Safe to call on every startup — it checks sentinels and returns immediately
 * if migration has already been completed at the current version.
 *
 * Global state and secrets share one sentinel (in globalState file store).
 * Workspace state has its own sentinel (in workspaceState file store) so that
 * each new workspace gets migrated independently.
 *
 * @param vscodeContext The VSCode ExtensionContext (source of truth for legacy data)
 * @param storage The file-backed StorageContext (destination)
 * @returns Summary of what was migrated
 */
export async function exportVSCodeStorageToSharedFiles(
	vscodeContext: vscode.ExtensionContext,
	storage: StorageContext,
): Promise<MigrationResult> {
	const result: MigrationResult = {
		migrated: false,
		globalStateCount: 0,
		secretsCount: 0,
		workspaceStateCount: 0,
		skippedExisting: 0,
	}

	// Check sentinels independently
	const globalVersion = storage.globalState.get<number>(MIGRATION_VERSION_KEY)
	const workspaceVersion = storage.workspaceState.get<number>(MIGRATION_VERSION_KEY)

	const needGlobalMigration = globalVersion === undefined || globalVersion < CURRENT_MIGRATION_VERSION
	const needWorkspaceMigration = workspaceVersion === undefined || workspaceVersion < CURRENT_MIGRATION_VERSION

	if (!needGlobalMigration && !needWorkspaceMigration) {
		Logger.info(
			`[Migration] File-backed stores already current (global: v${globalVersion}, workspace: v${workspaceVersion}), skipping.`,
		)
		return result
	}

	Logger.info(
		`[Migration] Starting VSCode → file-backed migration (global: ${globalVersion ?? "none"}, workspace: ${workspaceVersion ?? "none"}, target: ${CURRENT_MIGRATION_VERSION})`,
	)

	try {
		// ─── 1. Migrate global state + secrets (if needed) ─────────────
		if (needGlobalMigration) {
			// Batch global state keys
			const globalStateBatch: Record<string, any> = {}
			for (const key of GlobalStateAndSettingKeys) {
				if (SKIP_GLOBAL_STATE_KEYS.has(key)) {
					continue
				}

				const vscodeValue = vscodeContext.globalState.get(key)
				if (vscodeValue === undefined) {
					continue
				}

				const existingFileValue = storage.globalState.get(key)
				if (existingFileValue !== undefined) {
					result.skippedExisting++
					continue
				}

				globalStateBatch[key] = vscodeValue
				result.globalStateCount++
			}

			// Add sentinel to batch
			globalStateBatch[MIGRATION_VERSION_KEY] = CURRENT_MIGRATION_VERSION

			// Write all global state in one operation
			storage.globalState.setBatch(globalStateBatch)

			// Batch secrets
			const secretsBatch: Record<string, string> = {}
			for (const key of SecretKeys) {
				try {
					const vscodeValue = await vscodeContext.secrets.get(key)
					if (vscodeValue === undefined || vscodeValue === "") {
						continue
					}

					const existingFileValue = storage.secrets.get(key)
					if (existingFileValue !== undefined && existingFileValue !== "") {
						result.skippedExisting++
						continue
					}

					secretsBatch[key] = vscodeValue
					result.secretsCount++
				} catch (error) {
					Logger.error(`[Migration] Failed to read secret '${key}' from VSCode:`, error)
				}
			}

			// Write all secrets in one operation
			storage.secrets.setBatch(secretsBatch)
		}

		// ─── 2. Migrate workspace state (if needed) ────────────────────
		if (needWorkspaceMigration) {
			// Batch workspace state keys
			const workspaceStateBatch: Record<string, any> = {}
			for (const key of LocalStateKeys) {
				const vscodeValue = vscodeContext.workspaceState.get(key)
				if (vscodeValue === undefined) {
					continue
				}

				const existingFileValue = storage.workspaceState.get(key)
				if (existingFileValue !== undefined) {
					result.skippedExisting++
					continue
				}

				workspaceStateBatch[key] = vscodeValue
				result.workspaceStateCount++
			}

			// Add sentinel to batch
			workspaceStateBatch[MIGRATION_VERSION_KEY] = CURRENT_MIGRATION_VERSION

			// Write all workspace state in one operation
			storage.workspaceState.setBatch(workspaceStateBatch)
		}

		result.migrated = true

		// ─── 3. Migrate global storage folders (tasks, history, etc.) ───
		await migrateGlobalStorageFolders(vscodeContext, storage)

		Logger.info(
			`[Migration] Complete: ${result.globalStateCount} global state keys, ` +
				`${result.secretsCount} secrets, ${result.workspaceStateCount} workspace state keys migrated. ` +
				`${result.skippedExisting} keys skipped (already in file store).`,
		)
	} catch (error) {
		Logger.error("[Migration] Fatal error during VSCode → file-backed migration:", error)
		// Don't write sentinel on failure — migration will retry next startup
		throw error
	}

	return result
}

/**
 * Migrate global storage folders (tasks, checkpoints, etc.) to the shared Dirac directory.
 */
export async function migrateGlobalStorageFolders(
	vscodeContext: vscode.ExtensionContext,
	storage: StorageContext,
): Promise<void> {
	const oldPath = vscodeContext.globalStorageUri.fsPath
	const newPath = storage.dataDir

	if (oldPath === newPath) {
		return
	}

	const foldersToMigrate = ["tasks", "checkpoints", "settings", "cache", "state"]

	for (const folder of foldersToMigrate) {
		const source = path.join(oldPath, folder)
		const dest = path.join(newPath, folder)

		if (!(await fileExistsAtPath(source))) {
			continue
		}

		try {
			if (!(await fileExistsAtPath(dest))) {
				// Destination doesn't exist, safe to copy entire folder
				await fs.mkdir(path.dirname(dest), { recursive: true })
				await fs.cp(source, dest, { recursive: true })
				Logger.info(`[Migration] Migrated ${folder} folder to shared storage.`)
			} else {
				// Destination exists, merge contents
				if (folder === "state") {
					const sourceHistory = path.join(source, "taskHistory.json")
					const destHistory = path.join(dest, "taskHistory.json")
					if (await fileExistsAtPath(sourceHistory)) {
						if (await fileExistsAtPath(destHistory)) {
							await mergeTaskHistory(sourceHistory, destHistory)
							Logger.info("[Migration] Merged task history from VSCode to shared storage.")
						} else {
							await fs.mkdir(dest, { recursive: true })
							await fs.copyFile(sourceHistory, destHistory)
							Logger.info("[Migration] Copied task history to shared storage.")
						}
					}
				} else {
					// Generic merge: copy files that don't exist in destination
					await fs.cp(source, dest, { recursive: true, force: false })
					Logger.info(`[Migration] Merged ${folder} folder contents to shared storage.`)
				}
			}
		} catch (error) {
			Logger.error(`[Migration] Failed to migrate ${folder} folder:`, error)
		}
	}
}

async function mergeTaskHistory(sourceFile: string, destFile: string) {
	try {
		const sourceContent = await fs.readFile(sourceFile, "utf8")
		const destContent = await fs.readFile(destFile, "utf8")

		const sourceData = JSON.parse(sourceContent) as HistoryItem[]
		const destData = JSON.parse(destContent) as HistoryItem[]

		if (!Array.isArray(sourceData) || !Array.isArray(destData)) {
			return
		}

		const combined = [...destData]
		const destIds = new Set(destData.map((item) => item.id))

		for (const item of sourceData) {
			if (item && item.id && !destIds.has(item.id)) {
				combined.push(item)
			}
		}

		combined.sort((a, b) => (b.ts || 0) - (a.ts || 0))
		await fs.writeFile(destFile, JSON.stringify(combined, null, 2))
	} catch (error) {
		Logger.error("[Migration] Error merging task history files:", error)
	}
}
