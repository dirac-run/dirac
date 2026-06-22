import { version as CLI_VERSION } from "../package.json"
import { window } from "./vscode-shim"
import type { CliContext, InitOptions } from "./types"
import { setActiveContext } from "./utils/state"

/**
 * Initialize all CLI infrastructure and return context needed for commands
 */
export async function initializeCli(options: InitOptions): Promise<CliContext> {
    const { setRuntimeHooksDir } = await import("@/core/storage/disk")
    const { initializeCliContext } = await import("./vscode-context")
    const { Logger } = await import("@/shared/services/Logger")
    const { autoUpdateOnStartup } = await import("./utils/update")
    const { Session } = await import("@/shared/services/Session")
    const { AuthHandler } = await import("@/hosts/external/AuthHandler")
    const { HostProvider } = await import("@/hosts/host-provider")
    const { CliWebviewProvider } = await import("./controllers/CliWebviewProvider")
    const { FileEditProvider } = await import("@/integrations/editor/FileEditProvider")
    const { CliCommentReviewController } = await import("./controllers/CliCommentReviewController")
    const { StandaloneTerminalManager } = await import("@/integrations/terminal/standalone/StandaloneTerminalManager")
    const { createCliHostBridgeProvider } = await import("./controllers")
    const { getCliBinaryPath, DIRAC_CLI_DIR } = await import("./utils/path")
    const { StateManager } = await import("@/core/storage/StateManager")
    const { initCoreServices } = await import("./initCoreServices")
    const { telemetryService } = await import("@/services/telemetry")
    const { SymbolIndexService } = await import("@/services/symbol-index/SymbolIndexService")

    const workspacePath = options.cwd || process.cwd()
    setRuntimeHooksDir(options.hooksDir)
    const { extensionContext, storageContext, DATA_DIR, EXTENSION_DIR } = initializeCliContext({
        diracDir: options.config,
        workspaceDir: workspacePath,
    })

    // Set up output channel and Logger early so DiracEndpoint.initialize logs are captured
    const outputChannel = window.createOutputChannel("Dirac CLI")
    const logToChannel = (message: string) => outputChannel.appendLine(message)

    // Configure the shared Logging class early to capture all initialization logs
    Logger.subscribe(logToChannel)

    // HostProvider must be initialized before StateManager (initCoreServices →
    // StateManager.initialize → initializeDistinctId reaches into HostProvider.env).
    HostProvider.initialize(
        "cli",
        () => new CliWebviewProvider(extensionContext as any),
        () => new FileEditProvider(),
        () => new CliCommentReviewController(),
        () => new StandaloneTerminalManager(),
        createCliHostBridgeProvider(workspacePath),
        logToChannel,
        async (path: string) => (options.enableAuth ? AuthHandler.getInstance().getCallbackUrl(path) : ""),
        getCliBinaryPath,
        EXTENSION_DIR,
        DATA_DIR,
        async (_cwd: string) => undefined,
    )

    // DiracEndpoint + StateManager + ErrorService go through the shared
    // helper so the ACP entrypoint can't drift out of sync (see initCoreServices).
    await initCoreServices({ extensionDir: EXTENSION_DIR, storageContext })

    // Auto-update check (after endpoints initialized, so we can detect bundled configs)
    autoUpdateOnStartup(CLI_VERSION)

    // Initialize/reset session tracking for this CLI run
    Session.reset()

    if (options.enableAuth) {
        AuthHandler.getInstance().setEnabled(true)
    }

    outputChannel.appendLine(
        `Dirac CLI initialized. Data dir: ${DATA_DIR}, Extension dir: ${EXTENSION_DIR}, Log dir: ${DIRAC_CLI_DIR.log}`,
    )

    const stateManager = StateManager.get()
    const { getProviderFromEnv } = await import("@shared/storage/env-config")
    const envProvider = getProviderFromEnv()
    if (envProvider) {
        if (!stateManager.getGlobalSettingsKey("actModeApiProvider")) {
            stateManager.setSessionOverride("actModeApiProvider", envProvider)
        }
        if (!stateManager.getGlobalSettingsKey("planModeApiProvider")) {
            stateManager.setSessionOverride("planModeApiProvider", envProvider)
        }
    }

    const webview = HostProvider.get().createDiracWebviewProvider() as any
    const controller = webview.controller as any

    await telemetryService.captureExtensionActivated()
    await telemetryService.captureHostEvent("dirac_cli", "initialized")

    // =============== Symbol Index Service ===============
    // Initialize symbol index for the project in background with a delay
    // to avoid blocking UI rendering (matches VS Code extension behavior).
    // Skipped entirely when --no-index is set.
    if (!options.noIndex) {
        const INITIALIZATION_DELAY_MS = 5000
        setTimeout(() => {
            SymbolIndexService.getInstance()
                .initialize(workspacePath)
                .catch((error) => {
                    Logger.error("[Dirac] Failed to initialize SymbolIndexService:", error)
                })
        }, INITIALIZATION_DELAY_MS)
    }

    const ctx = { extensionContext, dataDir: DATA_DIR, extensionDir: EXTENSION_DIR, workspacePath, controller }
    setActiveContext(ctx)
    return ctx
}
