import { DiracWebviewProvider } from "./core/webview";
import "./utils/path"; // necessary to have access to String.prototype.toPosix

import { createRotatingFileLogger, type RotatingFileLogger, resolveLogDirectory } from "@shared/services/file-logger";
import { HostProvider } from "@/hosts/host-provider";
import { Logger } from "@/shared/services/Logger";
import type { StorageContext } from "@/shared/storage/storage-context";
import { repairMissingTaskHistory } from "./core/commands/repairMissingTaskHistory";
import { FileContextTracker } from "./core/context/context-tracking/FileContextTracker";
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache";
import { HookProcessRegistry } from "./core/hooks/HookProcessRegistry";
import { StateManager } from "./core/storage/StateManager";
import { AgentConfigLoader } from "./core/task/tools/subagent/AgentConfigLoader";
import { ErrorService } from "./services/error";
import { featureFlagsService } from "./services/feature-flags";
import { getDistinctId } from "./services/logging/distinctId";
import { recordVersionUpgrade } from "./services/release-notes/recordVersionUpgrade";
import { SymbolIndexService } from "./services/symbol-index/SymbolIndexService";
import { telemetryService } from "./services/telemetry";
// Legacy telemetry removed
import { DiracTempManager } from "./services/temp";
import { ShowMessageType } from "./shared/proto/host/window";
import { syncWorker } from "./shared/services/worker/sync";
import { getBlobStoreSettingsFromEnv } from "./shared/services/worker/worker";
import { arePathsEqual } from "./utils/path";

let persistentFileLogger: RotatingFileLogger | undefined
let unsubscribeHostLogger: (() => void) | undefined
let unsubscribeFileLogger: (() => void) | undefined

async function disposePersistentLogging(): Promise<void> {
	unsubscribeHostLogger?.()
	unsubscribeHostLogger = undefined
	unsubscribeFileLogger?.()
	unsubscribeFileLogger = undefined

	const logger = persistentFileLogger
	persistentFileLogger = undefined
	if (logger) await logger.dispose()
}

/**
 * Performs intialization for Dirac that is common to all platforms.
 *
 * @param context
 * @returns The webview provider
 * @throws DiracConfigurationError if endpoints.json exists but is invalid
 */
export async function initialize(storageContext: StorageContext): Promise<DiracWebviewProvider> {
	await disposePersistentLogging()
	try {
		unsubscribeHostLogger = Logger.subscribe((msg: string) => HostProvider.get().logToChannel(msg))
		persistentFileLogger = createRotatingFileLogger({
			logDir: resolveLogDirectory(storageContext.dataDir),
			fileName: "dirac-ext.log",
		})
		unsubscribeFileLogger = Logger.subscribe(persistentFileLogger.write)
		return await initializeServices(storageContext)
	} catch (error) {
		await disposePersistentLogging()
		throw error
	}
}

async function initializeServices(storageContext: StorageContext): Promise<DiracWebviewProvider> {
	// Initialize DiracEndpoint configuration (reads bundled and ~/.dirac/endpoints.json if present)
	// This must be done before any other code that calls DiracEnv.config()
	// Throws DiracConfigurationError if config file exists but is invalid
	const { DiracEndpoint } = await import("./config")
	await DiracEndpoint.initialize(HostProvider.get().extensionFsPath)

	try {
		await StateManager.initialize(storageContext)
	} catch (error) {
		Logger.error("[Dirac] CRITICAL: Failed to initialize StateManager:", error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Failed to initialize storage. Please check logs for details or try restarting the client.",
		})
	}

	// =============== External services ===============
	await ErrorService.initialize()
	// Legacy telemetry removed

	const stateManager = StateManager.get()
	// Record an exact-version upgrade before constructing a webview/controller that can publish state.
	await recordVersionUpgrade(stateManager)

	// =============== Webview services ===============
	const webview = HostProvider.get().createDiracWebviewProvider()
	void webview.controller
		.waitForGoalStartupReconciliation()
		.then(() => repairMissingTaskHistory(stateManager))
		.then(async (result) => {
			if (result.recovered > 0) await stateManager.onSyncExternalChange?.()
		})
		.catch((error) => {
			Logger.error("[Task History Repair] Background repair failed:", error)
		})
	// Check if this workspace was opened from worktree quick launch
	await checkWorktreeAutoOpen(stateManager)

	// =============== Background sync and cleanup tasks ===============
	// Use remote config blobStoreConfig if available, otherwise fall back to env vars
	const blobStoreSettings = getBlobStoreSettingsFromEnv()
	syncWorker().init({ ...blobStoreSettings, userDistinctId: getDistinctId() })
	// Clean up old temp files in background (non-blocking) and start periodic cleanup every 24 hours
	DiracTempManager.startPeriodicCleanup()
	// Clean up orphaned file context warnings (startup cleanup)
	FileContextTracker.cleanupOrphanedWarnings(stateManager)

	telemetryService.captureExtensionActivated()

	// =============== Symbol Index Service ===============
	// Initialize symbol index for the project in background with a delay to avoid blocking startup
	const INITIALIZATION_DELAY_MS = 5000
	setTimeout(() => {
		HostProvider.workspace.getWorkspacePaths({}).then((response) => {
			const paths = response.paths
			if (paths && paths.length > 0) {
				const projectRoot = paths[0]
				SymbolIndexService.getInstance()
					.initialize(projectRoot)
					.catch((error) => {
						Logger.error("[Dirac] Failed to initialize SymbolIndexService:", error)
					})
			}
		})
	}, INITIALIZATION_DELAY_MS)

	return webview
}

/**
 * Checks if this workspace was opened from the worktree quick launch button.
 * If so, opens the Dirac sidebar and clears the state.
 */
async function checkWorktreeAutoOpen(stateManager: StateManager): Promise<void> {
	try {
		// Read directly from globalState (not StateManager cache) since this may have been
		// set by another window right before this one opened
		const worktreeAutoOpenPath = stateManager.getGlobalStateKey("worktreeAutoOpenPath")
		if (!worktreeAutoOpenPath) {
			return
		}

		// Get current workspace path
		const workspacePaths = (await HostProvider.workspace.getWorkspacePaths({})).paths
		if (workspacePaths.length === 0) {
			return
		}

		const currentPath = workspacePaths[0]

		// Check if current workspace matches the worktree path
		if (arePathsEqual(currentPath, worktreeAutoOpenPath)) {
			// Clear the state first to prevent re-triggering
			stateManager.setGlobalState("worktreeAutoOpenPath", undefined)
			// Open the Dirac sidebar
			await HostProvider.workspace.openDiracSidebarPanel({})
		}
	} catch (error) {
		Logger.error("Error checking worktree auto-open", error)
	}
}

/**
 * Performs cleanup when Dirac is deactivated that is common to all platforms.
 */
export async function tearDown(): Promise<void> {
	try {
		await tearDownServices()
	} finally {
		await disposePersistentLogging()
	}
}

async function tearDownServices(): Promise<void> {
	AgentConfigLoader.getInstance()?.dispose()
	// Legacy telemetry removed
	telemetryService.dispose()
	ErrorService.get().dispose()
	featureFlagsService.dispose()
	// Dispose all webview instances
	await DiracWebviewProvider.disposeAllInstances()
	if (StateManager.isInitialized()) await StateManager.get().flushPendingState()
	syncWorker().dispose()

	// Kill any running hook processes to prevent zombies
	await HookProcessRegistry.terminateAll()
	// Clean up hook discovery cache
	HookDiscoveryCache.getInstance().dispose()
	// Stop periodic temp file cleanup
	DiracTempManager.stopPeriodicCleanup()
	SymbolIndexService.getInstance().dispose()

	// Clean up test mode — only exists on hosts that run e2e test mode (VS Code)
	HostProvider.get().capabilities.cleanupTestMode?.()
}
