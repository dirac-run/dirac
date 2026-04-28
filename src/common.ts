import { DiracWebviewProvider } from "./core/webview";
import "./utils/path"; // necessary to have access to String.prototype.toPosix

import { HostProvider } from "@/hosts/host-provider";
import { Logger } from "@/shared/services/Logger";
import type { StorageContext } from "@/shared/storage/storage-context";
import { FileContextTracker } from "./core/context/context-tracking/FileContextTracker";
import { clearOnboardingModelsCache } from "./core/controller/models/getDiracOnboardingModels";
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache";
import { HookProcessRegistry } from "./core/hooks/HookProcessRegistry";
import { StateManager } from "./core/storage/StateManager";
import { AgentConfigLoader } from "./core/task/tools/subagent/AgentConfigLoader";
import { ExtensionRegistryInfo } from "./registry";
import { ErrorService } from "./services/error";
import { featureFlagsService } from "./services/feature-flags";
import { getDistinctId } from "./services/logging/distinctId";
import { SymbolIndexService } from "./services/symbol-index/SymbolIndexService";
import { telemetryService } from "./services/telemetry";
// Legacy telemetry removed
import { DiracTempManager } from "./services/temp";
import { cleanupTestMode } from "./services/test/TestMode";
import { ShowMessageType } from "./shared/proto/host/window";
import { syncWorker } from "./shared/services/worker/sync";

import { getBlobStoreSettingsFromEnv } from "./shared/services/worker/worker";
import { getLatestAnnouncementId } from "./utils/announcements";
import { arePathsEqual } from "./utils/path";

/**
 * Performs intialization for Dirac that is common to all platforms.
 *
 * @param context
 * @returns The webview provider
 * @throws DiracConfigurationError if endpoints.json exists but is invalid
 */
export async function initialize(storageContext: StorageContext): Promise<DiracWebviewProvider> {
	// Configure the shared Logging class to use HostProvider's output channels and debug logger
	Logger.subscribe((msg: string) => HostProvider.get().logToChannel(msg)) // File system logging
	Logger.subscribe((msg: string) => HostProvider.env.debugLog({ value: msg })) // Host debug logging

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

	// =============== Webview services ===============
	const webview = HostProvider.get().createDiracWebviewProvider()

	const stateManager = StateManager.get()
	// Non-blocking announcement check and display
	showVersionUpdateAnnouncement(stateManager)
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
	const symbolIndexTimer = setTimeout(() => {
		HostProvider.workspace
			.getWorkspacePaths({})
			.then((response) => {
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
			.catch((error) => {
				Logger.error("[Dirac] Failed to resolve workspace paths for SymbolIndexService:", error)
			})
	}, INITIALIZATION_DELAY_MS)
	symbolIndexTimer.unref?.()

	return webview
}

async function showVersionUpdateAnnouncement(stateManager: StateManager) {
	// Version checking for autoupdate notification

	const currentVersion = ExtensionRegistryInfo.version
	const previousVersion = stateManager.getGlobalStateKey("diracVersion")
	// Perform post-update actions if necessary
	try {
		if (!previousVersion || currentVersion !== previousVersion) {
			Logger.log(`Dirac version changed: ${previousVersion} -> ${currentVersion}. First run or update detected.`)

			// Check if there's a new announcement to show
			// Update version key name if needed
			const previousDiracVersion = stateManager.getGlobalStateKey("diracVersion" as any)
			if (previousDiracVersion && !previousVersion) {
				// This is handled by migrateDiracToDirac but as a safety measure
			}

			const lastShownAnnouncementId = stateManager.getGlobalStateKey("lastShownAnnouncementId")
			const latestAnnouncementId = getLatestAnnouncementId()

			if (lastShownAnnouncementId !== latestAnnouncementId) {
				// Show notification when there's a new announcement (major/minor updates or fresh installs)
				const message = previousVersion
					? `Dirac has been updated to v${currentVersion}`
					: `Welcome to Dirac v${currentVersion}`
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message,
				})
			}
			// Always update the main version tracker for the next launch.
			await stateManager.setGlobalState("diracVersion", currentVersion)
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		Logger.error(`Error during post-update actions: ${errorMessage}, Stack trace: ${error.stack}`)
	}
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
	AgentConfigLoader.getInstance()?.dispose()
	// Legacy telemetry removed
	telemetryService.dispose()
	ErrorService.get().dispose()
	featureFlagsService.dispose()
	// Dispose all webview instances
	await DiracWebviewProvider.disposeAllInstances()
	syncWorker().dispose()
	clearOnboardingModelsCache()

	// Kill any running hook processes to prevent zombies
	await HookProcessRegistry.terminateAll()
	// Clean up hook discovery cache
	HookDiscoveryCache.getInstance().dispose()
	// Stop periodic temp file cleanup
	DiracTempManager.stopPeriodicCleanup()
	SymbolIndexService.getInstance().dispose()

	// Clean up test mode
	cleanupTestMode()
}
