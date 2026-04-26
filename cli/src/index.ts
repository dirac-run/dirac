/**
 * Dirac CLI - TypeScript implementation with React Ink
 */

import { spawn } from "node:child_process"
import { exit } from "node:process"
import { Command } from "commander"
import { version as CLI_VERSION } from "../package.json"
import { suppressConsoleUnlessVerbose } from "./utils/console"

// CLI-only behavior: suppress console output unless verbose mode is enabled.
// Kept explicit here so importing the library bundle does not mutate global console methods.
suppressConsoleUnlessVerbose()

// Types and interfaces that don't trigger heavy module loading
import type { ApiProvider } from "@shared/api"
import type { Controller } from "@/core/controller"
import type { HistoryItem } from "@/shared/HistoryItem"
import type { OpenaiReasoningEffort } from "@/shared/storage/types"
import { CLI_LOG_FILE, shutdownEvent, window } from "./vscode-shim"

/**
 * Common options shared between runTask and resumeTask
 */
interface TaskOptions {
	act?: boolean
	plan?: boolean
	provider?: string
	kanban?: boolean
	model?: string
	verbose?: boolean
	cwd?: string
	continue?: boolean
	config?: string
	thinking?: boolean | string
	reasoningEffort?: string
	maxConsecutiveMistakes?: string
	yolo?: boolean
	autoApproveAll?: boolean
	doubleCheckCompletion?: boolean
	autoCondense?: boolean
	timeout?: string
	json?: boolean
	stdinWasPiped?: boolean
	hooksDir?: string
	subagents?: boolean
}

let telemetryDisposed = false

async function disposeTelemetryServices(): Promise<void> {
	if (telemetryDisposed) {
		return
	}

	telemetryDisposed = true
	const { telemetryService } = await import("@/services/telemetry")
	await Promise.allSettled([telemetryService.dispose()])
}

async function disposeCliContext(ctx: CliContext): Promise<void> {
	const { ErrorService } = await import("@/services/error/ErrorService")
	await ctx.controller.stateManager.flushPendingState()
	await ctx.controller.dispose()
	await ErrorService.get().dispose()
	await disposeTelemetryServices()
}

async function setModeScopedState(currentMode: "act" | "plan", setter: (mode: "act" | "plan") => void): Promise<void> {
	const { StateManager } = await import("@/core/storage/StateManager")
	const stateManager = StateManager.get()
	setter(currentMode)

	const separateModels = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting") ?? false
	if (!separateModels) {
		const otherMode: "act" | "plan" = currentMode === "act" ? "plan" : "act"
		setter(otherMode)
	}
}

async function normalizeReasoningEffort(value?: string): Promise<OpenaiReasoningEffort | undefined> {
	if (value === undefined) {
		return undefined
	}

	const { isOpenaiReasoningEffort } = await import("@/shared/storage/types")
	const normalized = value.toLowerCase()
	if (isOpenaiReasoningEffort(normalized)) {
		return normalized
	}
	const { OPENAI_REASONING_EFFORT_OPTIONS } = await import("@/shared/storage/types")
	const { printWarning } = await import("./utils/display")
	printWarning(
		`Invalid --reasoning-effort '${value}'. Using 'medium'. Valid values: ${OPENAI_REASONING_EFFORT_OPTIONS.join(", ")}.`,
	)
	return "medium"
}

async function validate_provider(provider: string): Promise<void> {
	const { ALL_MODEL_MAPS, ALL_PROVIDERS } = await import("@shared/api")
	const { printError } = await import("./utils/display")
	const { exit } = await import("node:process")

	if (provider.startsWith("http://") || provider.startsWith("https://")) {
		return
	}

	const validProviders = ALL_PROVIDERS || Array.from(new Set(ALL_MODEL_MAPS.map(([p]) => p)))
	if (!validProviders.includes(provider as any)) {
		printError(`Invalid provider '${provider}'. Valid providers: ${validProviders.sort().join(", ")}`)
		exit(1)
	}
}


async function normalizeMaxConsecutiveMistakes(value?: string): Promise<number | undefined> {
	if (value === undefined) {
		return undefined
	}

	const parsed = Number.parseInt(value, 10)
	if (Number.isNaN(parsed) || parsed < 1) {
		const { printWarning } = await import("./utils/display")
		printWarning(`Invalid --max-consecutive-mistakes value '${value}'. Expected integer >= 1.`)
		return undefined
	}

	return parsed
}

async function applyTaskOptions(options: TaskOptions): Promise<void> {
	const { StateManager } = await import("@/core/storage/StateManager")
	const { telemetryService } = await import("@/services/telemetry")
	const { getProviderModelIdKey } = await import("@/shared/storage")
	const { printWarning, printError, printInfo } = await import("./utils/display")
	const { exit } = await import("node:process")

	const stateManager = StateManager.get()

	if (process.env.OPENAI_COMPATIBLE_CUSTOM_KEY) {
		if (!options.provider || !options.model) {
			printError("Error: OPENAI_COMPATIBLE_CUSTOM_KEY requires --provider (base URL) and --model to be specified.")
			exit(1)
		}
		if (!options.provider || !options.provider.startsWith("http")) {
			printError("Error: When using OPENAI_COMPATIBLE_CUSTOM_KEY, --provider must be a base URL (starting with http/https).")
			exit(1)
		}
	}

	// Apply mode flag first so currentMode is correct for overrides
	if (options.plan) {
		stateManager.setSessionOverride("mode", "plan")
		telemetryService.captureHostEvent("mode_flag", "plan")
	} else if (options.act) {
		stateManager.setSessionOverride("mode", "act")
		telemetryService.captureHostEvent("mode_flag", "act")
	}


	// Validate provider/model combination
	if (options.provider && !options.model) {
		printError("Error: --provider requires --model to be specified.")
		exit(1)
	}

	// Apply model override if specified
	if (options.model) {
		const currentMode = (stateManager.getGlobalSettingsKey("mode") || "act") as "act" | "plan"

		if (options.provider) {
			await validate_provider(options.provider)
		}

		// Determine the target provider based on current mode or explicit flag
		let targetProvider: ApiProvider
		if (options.provider && (options.provider.startsWith("http://") || options.provider.startsWith("https://"))) {
			targetProvider = "openai"
			stateManager.setSessionOverride("openAiBaseUrl", options.provider)
		} else {
			const providerKey = currentMode === "act" ? "actModeApiProvider" : "planModeApiProvider"
			targetProvider = (options.provider as ApiProvider) || (stateManager.getGlobalSettingsKey(providerKey) as ApiProvider)
		}

		await setModeScopedState(currentMode, (mode) => {
			const pKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"

			// Ensure the provider is synced if setModeScopedState calls us for multiple modes
			stateManager.setSessionOverride(pKey, targetProvider)

			const modelKey = getProviderModelIdKey(targetProvider, mode)
			if (modelKey) {
				stateManager.setSessionOverride(modelKey, options.model!)
			}
		})
		telemetryService.captureHostEvent("model_flag", options.model)
		if (options.provider) {
			telemetryService.captureHostEvent("provider_flag", options.provider)
		}
	}

	const currentMode = (stateManager.getGlobalSettingsKey("mode") || "act") as "act" | "plan"

	// Set thinking budget based on --thinking flag (boolean or number)
	if (options.thinking !== undefined) {
		let thinkingBudget = 1024
		if (typeof options.thinking === "string") {
			const parsed = Number.parseInt(options.thinking, 10)
			if (Number.isNaN(parsed) || parsed < 0) {
				printWarning(`Invalid --thinking value '${options.thinking}'. Using default 1024.`)
			} else {
				thinkingBudget = parsed
			}
		}

		await setModeScopedState(currentMode, (mode) => {
			const thinkingKey = mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens"
			stateManager.setSessionOverride(thinkingKey, thinkingBudget)
		})
		telemetryService.captureHostEvent("thinking_flag", "true")
	}

	const reasoningEffort = await normalizeReasoningEffort(options.reasoningEffort)
	if (reasoningEffort !== undefined) {
		await setModeScopedState(currentMode, (mode) => {
			const reasoningKey = mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort"
			stateManager.setSessionOverride(reasoningKey, reasoningEffort)
		})
		telemetryService.captureHostEvent("reasoning_effort_flag", reasoningEffort)
	}

	const maxConsecutiveMistakes = await normalizeMaxConsecutiveMistakes(options.maxConsecutiveMistakes)
	if (maxConsecutiveMistakes !== undefined) {
		stateManager.setSessionOverride("maxConsecutiveMistakes", maxConsecutiveMistakes)
		telemetryService.captureHostEvent("max_consecutive_mistakes_flag", String(maxConsecutiveMistakes))
	}

	// Set yolo mode as a session-scoped override so AutoApprove picks it up,
	// but it is never persisted to disk (setSessionOverride never touches pendingGlobalState).
	if (options.yolo) {
		stateManager.setSessionOverride("yoloModeToggled", true)
		telemetryService.captureHostEvent("yolo_flag", "true")
	}

	// Set auto-approve-all as a session-scoped override so CLI flag does not
	// persist user settings to disk.
	if (options.autoApproveAll) {
		stateManager.setSessionOverride("autoApproveAllToggled", true)
		telemetryService.captureHostEvent("auto_approve_all_flag", "true")
	}

	// Set double-check completion based on flag
	if (options.doubleCheckCompletion) {
		stateManager.setSessionOverride("doubleCheckCompletionEnabled", true)
		telemetryService.captureHostEvent("double_check_completion_flag", "true")
	}

	if (options.subagents) {
		stateManager.setSessionOverride("subagentsEnabled", true)
	}

	if (options.autoCondense) {
		stateManager.setSessionOverride("useAutoCondense", true)
	}
}

/**
 * Get mode selection result using the extracted, testable selectOutputMode function.
 * This wrapper provides the current process TTY state.
 */
async function getModeSelection(options: TaskOptions) {
	const { selectOutputMode } = await import("./utils/mode-selection")
	return selectOutputMode({
		stdoutIsTTY: process.stdout.isTTY === true,
		stdinIsTTY: process.stdin.isTTY === true,
		stdinWasPiped: options.stdinWasPiped ?? false,
		json: options.json,
		yolo: options.yolo,
	})
}

/**
 * Determine if plain text mode should be used based on options and environment.
 */
async function shouldUsePlainTextMode(options: TaskOptions): Promise<boolean> {
	return (await getModeSelection(options)).usePlainTextMode
}

/**
 * Get the reason for using plain text mode (for telemetry).
 */
async function getPlainTextModeReason(options: TaskOptions): Promise<string> {
	return (await getModeSelection(options)).reason
}

function getNpxCommand(): string {
	return process.platform === "win32" ? "npx.cmd" : "npx"
}

async function runKanbanAlias(): Promise<void> {
	const { printWarning } = await import("./utils/display")
	const child = spawn(getNpxCommand(), ["-y", "kanban", "--agent", "dirac"], {
		stdio: "inherit",
	})

	child.on("error", () => {
		printWarning("Failed to run 'npx kanban --agent dirac'. Make sure npx is installed and available in PATH.")
		exit(1)
	})

	child.on("close", (code) => {
		exit(code ?? 1)
	})
}

/**
 * Run a task in plain text mode (no Ink UI).
 * Handles auth check, task execution, cleanup, and exit.
 */
async function runTaskInPlainTextMode(
	ctx: CliContext,
	options: TaskOptions,
	taskConfig: {
		prompt?: string
		taskId?: string
		imageDataUrls?: string[]
	},
): Promise<never> {
	const { isAuthConfigured } = await import("./utils/auth")
	const { printWarning } = await import("./utils/display")
	const { telemetryService } = await import("@/services/telemetry")
	const { runPlainTextTask } = await import("./utils/plain-text-task")

	// Set flag so shutdown handler knows not to clear Ink UI lines
	isPlainTextMode = true

	// Check if auth is configured before attempting to run the task
	// In plain text mode we can't show the interactive auth flow
	const hasAuth = await isAuthConfigured()
	if (!hasAuth) {
		printWarning("Not authenticated. Please run 'dirac auth' first to configure your API credentials.")
		await disposeCliContext(ctx)
		exit(1)
	}

	const reason = await getPlainTextModeReason(options)
	telemetryService.captureHostEvent("plain_text_mode", reason)

	// Plain text mode: no Ink rendering, just clean text output
	const success = await runPlainTextTask({
		controller: ctx.controller,
		yolo: options.yolo || options.autoApproveAll,
		prompt: taskConfig.prompt,
		taskId: taskConfig.taskId,
		imageDataUrls: taskConfig.imageDataUrls,
		verbose: options.verbose,
		jsonOutput: options.json,
		timeoutSeconds: options.timeout ? Number.parseInt(options.timeout, 10) : undefined,
	})

	// Cleanup
	await disposeCliContext(ctx)

	// Ensure stdout is fully drained before exiting - critical for piping
	await drainStdout()
	exit(success ? 0 : 1)
}

/**
 * Create the standard cleanup function for Ink apps.
 */
function createInkCleanup(ctx: CliContext, onTaskError?: () => boolean): () => Promise<void> {
	return async () => {
		await disposeCliContext(ctx)
		if (onTaskError?.()) {
			const { printWarning } = await import("./utils/display")
			printWarning("Task ended with errors.")
			exit(1)
		}
		exit(0)
	}
}

// Track active context for graceful shutdown
let activeContext: CliContext | null = null
let isShuttingDown = false
// Track if we're in plain text mode (no Ink UI) - set by runTask when piped stdin detected
let isPlainTextMode = false

/**
 * Wait for stdout to fully drain before exiting.
 * Critical for piping - ensures data is flushed to the next command in the pipe.
 */
async function drainStdout(): Promise<void> {
	return new Promise<void>((resolve) => {
		// Check if stdout needs draining
		if (process.stdout.writableNeedDrain) {
			process.stdout.once("drain", resolve)
		} else {
			// Give a small delay to ensure any pending writes complete
			setImmediate(resolve)
		}
	})
}

export async function captureUnhandledException(reason: Error, context: string) {
	try {
		const { ErrorService } = await import("@/services/error/ErrorService")
		const { Logger } = await import("@/shared/services/Logger")
		// ErrorService may not be initialized yet (e.g., error occurred before initializeCli())
		// so we guard with a try/get pattern rather than letting ErrorService.get() throw
		let errorService: any = null
		try {
			errorService = ErrorService.get()
		} catch {
			// ErrorService not yet initialized; skip capture
		}
		if (errorService) {
			await errorService.captureException(reason, { context })
			// dispose flushes any pending error captures to ensure they're sent before the process exits
			return errorService.dispose()
		}
	} catch {
		// Ignore errors during shutdown to avoid an infinite loop
		try {
			const { Logger } = await import("@/shared/services/Logger")
			Logger.info("Error capturing unhandled exception. Proceeding with shutdown.")
		} catch {
			// Even Logger failed
		}
	}
}

export function hasExplicitAuthQuickSetupFlags(options: { provider?: string; apikey?: string; modelid?: string }): boolean {
	return !!(options.provider && options.apikey && options.modelid)
}

const EXIT_TIMEOUT_MS = 3000
async function onUnhandledException(reason: unknown, context: string) {
	const { Logger } = await import("@/shared/services/Logger")
	const { restoreConsole } = await import("./utils/console")
	Logger.error("Unhandled exception:", reason)
	const finalError = reason instanceof Error ? reason : new Error(String(reason))

	restoreConsole()
	console.error(finalError)

	setTimeout(() => process.exit(1), EXIT_TIMEOUT_MS)

	captureUnhandledException(finalError, context).finally(() => {
		process.exit(1)
	})
}

function setupSignalHandlers() {
	const shutdown = async (signal: string) => {
		const { printWarning } = await import("./utils/display")
		if (isShuttingDown) {
			// Force exit on second signal
			process.exit(1)
		}
		isShuttingDown = true

		// Notify components to hide UI before shutdown
		shutdownEvent.fire()

		// Only clear Ink UI lines if we're not in plain text mode
		// In plain text mode, there's no Ink UI to clear and the ANSI codes
		// would corrupt the streaming output
		if (!isPlainTextMode) {
			// Clear several lines to remove the input field and footer from display
			// Move cursor up and clear lines (input box + footer rows)
			const linesToClear = 8 // Input box (3 lines with border) + footer (4-5 lines)
			process.stdout.write(`\x1b[${linesToClear}A\x1b[J`)
		}

		printWarning(`${signal} received, shutting down...`)

		try {
			if (activeContext) {
				const task = activeContext.controller.task
				if (task) {
					task.abortTask()
				}
				await disposeCliContext(activeContext)
			} else {
				// Best-effort flush of restored yolo state when no active context
				try {
					const { StateManager } = await import("@/core/storage/StateManager")
					await StateManager.get().flushPendingState()
				} catch {
					// StateManager may not be initialized yet
				}
				try {
					const { ErrorService } = await import("@/services/error/ErrorService")
					await ErrorService.get().dispose()
				} catch {
					// ErrorService may not be initialized yet
				}
				await disposeCliContext(activeContext as any) // This will call disposeTelemetryServices
			}
		} catch {
			// Best effort cleanup
		}

		process.exit(0)
	}

	process.on("SIGINT", () => shutdown("SIGINT"))
	process.on("SIGTERM", () => shutdown("SIGTERM"))

	// Suppress known abort errors from unhandled rejections
	// These occur when task is cancelled and async operations throw "Dirac instance aborted"
	process.on("unhandledRejection", async (reason: unknown) => {
		const message = reason instanceof Error ? reason.message : String(reason)
		// Silently ignore abort-related errors - they're expected during task cancellation
		if (message.includes("aborted") || message.includes("abort")) {
			try {
				const { Logger } = await import("@/shared/services/Logger")
				Logger.info("Suppressed unhandled rejection due to abort:", message)
			} catch {
				// Logger not available
			}
			return
		}

		// For other unhandled rejections, capture the exception and log to file via Logger (if available)
		// This won't show in terminal but will be in log files for debugging
		onUnhandledException(reason, "unhandledRejection")
	})

	process.on("uncaughtException", (reason: unknown) => {
		onUnhandledException(reason, "uncaughtException")
	})
}

setupSignalHandlers()

interface CliContext {
	extensionContext: any
	dataDir: string
	extensionDir: string
	workspacePath: string
	controller: Controller
}

interface InitOptions {
	config?: string
	cwd?: string
	hooksDir?: string
	verbose?: boolean
	enableAuth?: boolean
}

/**
 * Initialize all CLI infrastructure and return context needed for commands
 */
async function initializeCli(options: InitOptions): Promise<CliContext> {
	const { setRuntimeHooksDir } = await import("@/core/storage/disk")
	const { initializeCliContext } = await import("./vscode-context")
	const { Logger } = await import("@/shared/services/Logger")
	const { DiracEndpoint } = await import("@/config")
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
	const { ErrorService } = await import("@/services/error/ErrorService")
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

	await DiracEndpoint.initialize(EXTENSION_DIR)

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
		async (_cwd: string) => undefined
	)

	await StateManager.initialize(storageContext)
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
	await ErrorService.initialize()

	const webview = HostProvider.get().createDiracWebviewProvider() as any
	const controller = webview.controller as Controller

	await telemetryService.captureExtensionActivated()
	await telemetryService.captureHostEvent("dirac_cli", "initialized")

	// =============== Symbol Index Service ===============
	// Initialize symbol index for the project in background
	SymbolIndexService.getInstance()
		.initialize(workspacePath)
		.catch((error) => {
			Logger.error("[Dirac] Failed to initialize SymbolIndexService:", error)
		})


	const ctx = { extensionContext, dataDir: DATA_DIR, extensionDir: EXTENSION_DIR, workspacePath, controller }
	activeContext = ctx
	return ctx
}

/**
 * Run an Ink app with proper cleanup handling
 */
async function runInkApp(element: any, cleanup: () => Promise<void>): Promise<void> {
	const { render } = await import("ink")
	const { restoreConsole } = await import("./utils/console")

	// Clear terminal for clean UI - robot will render at row 1
	process.stdout.write("\x1b[2J\x1b[3J\x1b[H")

	// Note: incrementalRendering is disabled because it causes UI glitches on terminal resize.
	// Ink's incremental rendering tries to erase N lines based on previous output height,
	// but when the terminal shrinks, this leaves artifacts. Gemini CLI only enables
	// incrementalRendering when alternateBuffer is also enabled (which we don't use).
	const { waitUntilExit, unmount } = render(element, { exitOnCtrlC: true })

	try {
		await waitUntilExit()
	} finally {
		try {
			unmount()
		} catch {
			// Already unmounted
		}
		restoreConsole()
		await cleanup()
	}
}

/**
 * Run a task with the given prompt - uses welcome view for consistent behavior
 */
async function runTask(prompt: string, options: TaskOptions & { images?: string[] }, existingContext?: CliContext) {
	const { parseImagesFromInput, processImagePaths } = await import("./utils/parser")
	const { telemetryService } = await import("@/services/telemetry")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { checkRawModeSupport } = await import("./context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("./components/App")

	const ctx = existingContext || (await initializeCli({ ...options, enableAuth: true }))

	// Parse images from the prompt text (e.g., @/path/to/image.png)
	const { prompt: cleanPrompt, imagePaths: parsedImagePaths } = parseImagesFromInput(prompt)

	// Combine parsed image paths with explicit --images option
	const allImagePaths = [...(options.images || []), ...parsedImagePaths]
	// Convert image file paths to base64 data URLs
	const imageDataUrls = await processImagePaths(allImagePaths)

	// Use clean prompt (with image refs removed)
	const taskPrompt = cleanPrompt || prompt

	// Task without prompt starts in interactive mode
	telemetryService.captureHostEvent("task_command", prompt ? "task" : "interactive")

	// Capture piped stdin telemetry now that HostProvider is initialized
	if (options.stdinWasPiped) {
		telemetryService.captureHostEvent("piped", "detached")
	}

	// Apply shared task options (mode, model, thinking, yolo)
	await applyTaskOptions(options)
	await StateManager.get().flushPendingState()

	// Use plain text mode when output is redirected, stdin was piped, JSON mode is enabled, or --yolo flag is used
	if (await shouldUsePlainTextMode(options)) {
		return runTaskInPlainTextMode(ctx, options, {
			prompt: taskPrompt,
			imageDataUrls: imageDataUrls.length > 0 ? imageDataUrls : undefined,
		})
	}

	// Interactive mode: Render the welcome view with optional initial prompt/images
	// If prompt provided (dirac task "prompt"), ChatView will auto-submit
	// If no prompt (dirac interactive), user will type it in
	let taskError = false

	await runInkApp(
		React.createElement(App, {
			view: "welcome",
			verbose: options.verbose,
			controller: ctx.controller,
			isRawModeSupported: checkRawModeSupport(),
			initialPrompt: taskPrompt || undefined,
			initialImages: imageDataUrls.length > 0 ? imageDataUrls : undefined,
			onError: () => {
				taskError = true
			},
			onWelcomeExit: () => {
				// User pressed Esc; Ink exits and cleanup handles process exit.
			},
		}),
		createInkCleanup(ctx, () => taskError),
	)
}

/**
 * List task history
 */
async function listHistory(options: { config?: string; limit?: number; page?: number }) {
	const { StateManager } = await import("@/core/storage/StateManager")
	const { telemetryService } = await import("@/services/telemetry")
	const { printInfo } = await import("./utils/display")
	const { checkRawModeSupport } = await import("./context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("./components/App")

	const ctx = await initializeCli(options)

	const taskHistory = StateManager.get().getGlobalStateKey("taskHistory") || []
	// Sort by timestamp (newest first) before pagination
	const sortedHistory = [...taskHistory].sort((a: any, b: any) => (b.ts || 0) - (a.ts || 0))
	const limit = typeof options.limit === "string" ? Number.parseInt(options.limit, 10) : options.limit || 10
	const initialPage = typeof options.page === "string" ? Number.parseInt(options.page, 10) : options.page || 1
	const totalCount = sortedHistory.length
	const totalPages = Math.ceil(totalCount / limit)

	telemetryService.captureHostEvent("history_command", "executed")

	if (sortedHistory.length === 0) {
		printInfo("No task history found.")
		await disposeCliContext(ctx)
		exit(0)
	}

	await runInkApp(
		React.createElement(App, {
			view: "history",
			historyItems: [],
			historyAllItems: sortedHistory,
			controller: ctx.controller,
			historyPagination: { page: initialPage, totalPages, totalCount, limit },
			isRawModeSupported: checkRawModeSupport(),
		}),
		async () => {
			await disposeCliContext(ctx)
			exit(0)
		},
	)
}

/**
 * Show current configuration
 */
async function showConfig(options: { config?: string }) {
	const { StateManager } = await import("@/core/storage/StateManager")
	const { telemetryService } = await import("@/services/telemetry")
	const { getHooksEnabledSafe } = await import("@/core/hooks/hooks-utils")
	const { checkRawModeSupport } = await import("./context/StdinContext")
	const React = (await import("react")).default

	const ctx = await initializeCli(options)
	const stateManager = StateManager.get()

	// Dynamically import the wrapper to avoid circular dependencies
	const { ConfigViewWrapper } = await import("./components/ConfigViewWrapper")

	telemetryService.captureHostEvent("config_command", "executed")

	await runInkApp(
		React.createElement(ConfigViewWrapper, {
			controller: ctx.controller,
			dataDir: ctx.dataDir,
			globalState: stateManager.getAllGlobalStateEntries(),
			workspaceState: stateManager.getAllWorkspaceStateEntries(),
			hooksEnabled: getHooksEnabledSafe(stateManager.getGlobalSettingsKey("hooksEnabled")),
			skillsEnabled: true,
			isRawModeSupported: checkRawModeSupport(),
		}),
		async () => {
			await disposeCliContext(ctx)
			exit(0)
		},
	)
}

/**
 * Run authentication flow
 */
/**
 * Perform quick auth setup without UI - validates and saves configuration directly
 */
async function performQuickAuthSetup(
	ctx: CliContext,
	options: { provider: string; apikey: string; modelid: string; baseurl?: string; azureApiVersion?: string },
): Promise<{ success: boolean; error?: string }> {
	const { isValidCliProvider, getValidCliProviders } = await import("./utils/providers")
	const { applyProviderConfig } = await import("./utils/provider-config")
	const { StateManager } = await import("@/core/storage/StateManager")

	const { provider, apikey, modelid, baseurl, azureApiVersion } = options

	const normalizedProvider = provider.toLowerCase().trim()

	if (!isValidCliProvider(normalizedProvider)) {
		const validProviders = getValidCliProviders()
		return { success: false, error: `Invalid provider '${provider}'. Supported providers: ${validProviders.join(", ")}` }
	}

	if (normalizedProvider === "bedrock") {
		return {
			success: false,
			error: "Bedrock provider is not supported for quick setup due to complex authentication requirements. Please use interactive setup.",
		}
	}

	if (baseurl && !["openai", "openai-native"].includes(normalizedProvider)) {
		return { success: false, error: "Base URL is only supported for OpenAI and OpenAI-compatible providers" }
	}

	// Save configuration using shared utility
	await applyProviderConfig({
		providerId: normalizedProvider,
		apiKey: apikey,
		modelId: modelid,
		baseUrl: baseurl,
		azureApiVersion: azureApiVersion,
		controller: ctx.controller,
	})

	// Mark onboarding as complete
	StateManager.get().setGlobalState("welcomeViewCompleted", true)
	await StateManager.get().flushPendingState()

	return { success: true }
}

async function runAuth(options: {
	provider?: string
	apikey?: string
	modelid?: string
	baseurl?: string
	azureApiVersion?: string
	verbose?: boolean
	cwd?: string
	config?: string
}) {
	const { telemetryService } = await import("@/services/telemetry")
	const { printWarning, printInfo } = await import("./utils/display")
	const { checkRawModeSupport } = await import("./context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("./components/App")

	const ctx = await initializeCli({ ...options, enableAuth: true })

	let provider = options.provider
	let apikey = options.apikey
	let modelid = options.modelid
	let azureApiVersion = options.azureApiVersion

	if (!provider || !apikey || !modelid) {
		const { getSecretsFromEnv, getProviderFromEnv } = await import("@shared/storage/env-config")
		const { ProviderToApiKeyMap, getProviderDefaultModelId } = await import("@shared/storage")

		if (!provider) {
			provider = getProviderFromEnv()
			if (provider) {
				printInfo(`Inferred provider "${provider}" from environment variables`)
			}
		}

		if (provider && !apikey) {
			const envSecrets = getSecretsFromEnv()
			const normalizedProvider = provider.toLowerCase().trim()
			const secretKeyOrKeys = (ProviderToApiKeyMap as any)[normalizedProvider]
			if (secretKeyOrKeys) {
				const keys = Array.isArray(secretKeyOrKeys) ? secretKeyOrKeys : [secretKeyOrKeys]
				for (const key of keys) {
					const value = envSecrets[key as keyof typeof envSecrets]
					if (value) {
						apikey = value
						printInfo(`Using API key from environment for provider "${provider}"`)
						break
					}
				}
			}
		}

		if (provider && !modelid) {
			modelid = (getProviderDefaultModelId as any)(provider) || undefined
			if (modelid) {
				printInfo(`Using default model "${modelid}" for provider "${provider}"`)
			}
		}
	}

	const hasQuickSetupFlags = hasExplicitAuthQuickSetupFlags(options)

	telemetryService.captureHostEvent("auth_command", hasQuickSetupFlags ? "quick_setup" : "interactive")

	// Quick setup mode - no UI, just save configuration and exit
	if (hasQuickSetupFlags) {
		const result = await performQuickAuthSetup(ctx, {
			provider: provider!,
			apikey: apikey!,
			modelid: modelid!,
			baseurl: options.baseurl,
			azureApiVersion: options.azureApiVersion,
		})

		if (!result.success) {
			printWarning(result.error || "Quick setup failed")
			await telemetryService.captureHostEvent("auth", "error")
			await disposeCliContext(ctx)
			exit(1)
		}

		await telemetryService.captureHostEvent("auth", "completed")
		await disposeCliContext(ctx)
		exit(0)
	}

	// Interactive mode - show Ink UI
	let authError = false

	await runInkApp(
		React.createElement(App, {
			view: "auth",
			controller: ctx.controller,
			isRawModeSupported: checkRawModeSupport(),
			onComplete: () => {
				telemetryService.captureHostEvent("auth", "completed")
			},
			onError: () => {
				telemetryService.captureHostEvent("auth", "error")
				authError = true
			},
		}),
		async () => {
			await disposeCliContext(ctx)
			exit(authError ? 1 : 0)
		},
	)
}

// Setup CLI commands
const program = new Command()

program.name("dirac").description("Dirac CLI - AI coding assistant in your terminal").version(CLI_VERSION)

// Enable positional options to avoid conflicts between root and subcommand options with the same name
program.enablePositionalOptions()

program
	.command("task")
	.alias("t")
	.description("Run a new task")
	.argument("<prompt>", "The task prompt")
	.option("-a, --act", "Run in act mode")
	.option("-p, --plan", "Run in plan mode")
	.option("-y, --yolo", "Enable yes/yolo mode (auto-approve actions)")
	.option("--auto-approve-all", "Enable auto-approve all actions while keeping interactive mode")
	.option("-t, --timeout <seconds>", "Optional timeout in seconds (applies only when provided)")
	.option("-m, --model <model>", "Model to use for the task")
	.option("--provider <provider>", "API provider to use (requires --model)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory for the task")
	.option("--config <path>", "Path to Dirac configuration directory")
	.option("--thinking [tokens]", "Enable extended thinking (default: 1024 tokens)")
	.option("--reasoning-effort <effort>", "Reasoning effort: none|low|medium|high|xhigh")
	.option("--max-consecutive-mistakes <count>", "Maximum consecutive mistakes before halting in yolo mode")
	.option("--json", "Output messages as JSON instead of styled text")
	.option("--double-check-completion", "Reject first completion attempt to force re-verification")
	.option("--auto-condense", "Enable AI-powered context compaction instead of mechanical truncation")
	.option("--subagents", "Enable subagents for the task")
	.option("--hooks-dir <path>", "Path to additional hooks directory for runtime hook injection")
	.option("-T, --taskId <id>", "Resume an existing task by ID")
	.action((prompt, options) => {
		if (options.taskId) {
			return resumeTask(options.taskId, { ...options, initialPrompt: prompt })
		}
		return runTask(prompt, options)
	})

program
	.command("history")
	.alias("h")
	.description("List task history")
	.option("-n, --limit <number>", "Number of tasks to show", "10")
	.option("-p, --page <number>", "Page number (1-based)", "1")
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(listHistory)

program
	.command("config")
	.description("Show current configuration")
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(showConfig)

program
	.command("auth")
	.description("Authenticate a provider and configure what model is used")
	.option("-p, --provider <id>", "Provider ID for quick setup (e.g., openai-native, anthropic, moonshot)")
	.option("-k, --apikey <key>", "API key for the provider")
	.option("-m, --modelid <id>", "Model ID to configure (e.g., gpt-4o, claude-sonnet-4-6, kimi-k2.5)")
	.option("-b, --baseurl <url>", "Base URL (optional, only for openai provider)")
	.option("--azure-api-version <version>", "Azure API version (optional, only for azure openai)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory for the task")
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(runAuth)

program
	.command("version")
	.description("Show Dirac CLI version number")
	.action(async () => {
		const { printInfo } = await import("./utils/display")
		printInfo(`Dirac CLI version: ${CLI_VERSION}`)
	})

program
	.command("update")
	.description("Check for updates and install if available")
	.option("-v, --verbose", "Show verbose output")
	.action(async (options) => {
		const { checkForUpdates } = await import("./utils/update")
		return checkForUpdates(CLI_VERSION, options)
	})

program.command("kanban").description("Run npx kanban --agent dirac").action(runKanbanAlias)

// Dev command with subcommands
const devCommand = program.command("dev").description("Developer tools and utilities")

devCommand
	.command("log")
	.description("Open the log file")
	.action(async () => {
		const { openExternal } = await import("@/utils/env")
		await openExternal(CLI_LOG_FILE)
	})

/**
 * Validate that a task exists in history
 * @returns The task history item if found, null otherwise
 */
async function findTaskInHistory(taskId: string): Promise<HistoryItem | null> {
	const { StateManager } = await import("@/core/storage/StateManager")
	const taskHistory = StateManager.get().getGlobalStateKey("taskHistory") || []
	return (taskHistory as HistoryItem[]).find((item) => item.id === taskId) || null
}

/**
 * Resume an existing task by ID
 * Loads the task and optionally prefills the input with a prompt
 */
async function resumeTask(taskId: string, options: TaskOptions & { initialPrompt?: string }, existingContext?: CliContext) {
	const { printWarning, printInfo } = await import("./utils/display")
	const { telemetryService } = await import("@/services/telemetry")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { checkRawModeSupport } = await import("./context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("./components/App")

	const ctx = existingContext || (await initializeCli({ ...options, enableAuth: true }))

	// Validate task exists
	const historyItem = await findTaskInHistory(taskId)
	if (!historyItem) {
		printWarning(`Task not found: ${taskId}`)
		printInfo("Use 'dirac history' to see available tasks.")
		await disposeCliContext(ctx)
		exit(1)
	}

	telemetryService.captureHostEvent("resume_task_command", options.initialPrompt ? "with_prompt" : "interactive")

	// Capture piped stdin telemetry now that HostProvider is initialized
	if (options.stdinWasPiped) {
		telemetryService.captureHostEvent("piped", "detached")
	}

	// Apply shared task options (mode, model, thinking, yolo)
	await applyTaskOptions(options)
	await StateManager.get().flushPendingState()

	// Use plain text mode for non-interactive scenarios
	if (await shouldUsePlainTextMode(options)) {
		return runTaskInPlainTextMode(ctx, options, {
			prompt: options.initialPrompt,
			taskId: taskId,
		})
	}

	// Interactive mode: render the task view with the existing task
	let taskError = false

	await runInkApp(
		React.createElement(App, {
			view: "task",
			taskId: taskId,
			verbose: options.verbose,
			controller: ctx.controller,
			isRawModeSupported: checkRawModeSupport(),
			initialPrompt: options.initialPrompt || undefined,
			onError: () => {
				taskError = true
			},
			onWelcomeExit: () => {
				// User pressed Esc; Ink exits and cleanup handles process exit.
			},
		}),
		createInkCleanup(ctx, () => taskError),
	)
}

async function continueTask(options: TaskOptions) {
	const { findMostRecentTaskForWorkspace } = await import("./utils/task-history")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { printWarning, printInfo } = await import("./utils/display")

	const ctx = await initializeCli({ ...options, enableAuth: true })
	const historyItem = findMostRecentTaskForWorkspace(StateManager.get().getGlobalStateKey("taskHistory"), ctx.workspacePath)

	if (!historyItem) {
		printWarning(`No previous task found for ${ctx.workspacePath}`)
		printInfo("Start a new task or use 'dirac history' to browse previous tasks.")
		await disposeCliContext(ctx)
		exit(1)
	}

	return resumeTask(historyItem.id, options, ctx)
}

/**
 * Show welcome prompt and wait for user input
 * If auth is not configured, show auth flow first
 */
async function showWelcome(options: TaskOptions) {
	const { isAuthConfigured } = await import("./utils/auth")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { checkRawModeSupport } = await import("./context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("./components/App")

	const ctx = await initializeCli({ ...options, enableAuth: true })

	// Check if auth is configured
	const hasAuth = await isAuthConfigured()

	// Apply CLI task options in interactive startup too, so flags like
	// --auto-approve-all and --yolo affect the initial TUI state.
	await applyTaskOptions(options)
	await StateManager.get().flushPendingState()

	let hadError = false

	await runInkApp(
		React.createElement(App, {
			// Start with auth view if not configured, otherwise welcome
			view: hasAuth ? "welcome" : "auth",
			verbose: options.verbose,
			controller: ctx.controller,
			isRawModeSupported: checkRawModeSupport(),
			onWelcomeExit: () => {
				// User pressed Esc; Ink exits and cleanup handles process exit.
			},
			onError: () => {
				hadError = true
			},
		}),
		async () => {
			await disposeCliContext(ctx)
			exit(hadError ? 1 : 0)
		},
	)
}

// Interactive mode (default when no command given)
program
	.argument("[prompt]", "Task prompt (starts task immediately)")
	.option("-a, --act", "Run in act mode")
	.option("-p, --plan", "Run in plan mode")
	.option("-y, --yolo", "Enable yolo mode (auto-approve actions)")
	.option("--auto-approve-all", "Enable auto-approve all actions while keeping interactive mode")
	.option("-t, --timeout <seconds>", "Optional timeout in seconds (applies only when provided)")
	.option("-m, --model <model>", "Model to use for the task")
	.option("--provider <provider>", "API provider to use (requires --model)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory")
	.option("--config <path>", "Configuration directory")
	.option("--thinking [tokens]", "Enable extended thinking (default: 1024 tokens)")
	.option("--reasoning-effort <effort>", "Reasoning effort: none|low|medium|high|xhigh")
	.option("--max-consecutive-mistakes <count>", "Maximum consecutive mistakes before halting in yolo mode")
	.option("--json", "Output messages as JSON instead of styled text")
	.option("--double-check-completion", "Reject first completion attempt to force re-verification")
	.option("--auto-condense", "Enable AI-powered context compaction instead of mechanical truncation")
	.option("--subagents", "Enable subagents for the task")
	.option("--hooks-dir <path>", "Path to additional hooks directory for runtime hook injection")
	.option("--acp", "Run in ACP (Agent Client Protocol) mode for editor integration")
	.option("--kanban", "Run npx kanban --agent dirac")
	.option("-T, --taskId <id>", "Resume an existing task by ID")
	.option("--continue", "Resume the most recent task from the current working directory")
	.action(async (prompt, options) => {
		const { printWarning } = await import("./utils/display")
		if (options.kanban) {
			if (prompt) {
				printWarning("Use --kanban without a prompt.")
				exit(1)
			}

			await runKanbanAlias()
			return
		}

		// Check for ACP mode first - this takes precedence over everything else
		if (options.acp) {
			const { runAcpMode } = await import("./acp/index.js")
			await runAcpMode({
				config: options.config,
				cwd: options.cwd,
				hooksDir: options.hooksDir,
				verbose: options.verbose,
			})
			return
		}

		// Always check for piped stdin content
		const { readStdinIfPiped } = await import("./utils/piped")
		const stdinInput = await readStdinIfPiped()

		// Track whether stdin was actually piped (even if empty) vs not piped (null)
		// stdinInput === null means stdin wasn't piped (TTY or not FIFO/file)
		// stdinInput === "" means stdin was piped but empty
		// stdinInput has content means stdin was piped with data
		const stdinWasPiped = stdinInput !== null

		if (options.taskId && options.continue) {
			printWarning("Use either --taskId or --continue, not both.")
			exit(1)
		}

		if (options.continue) {
			if (prompt) {
				printWarning("Use --continue without a prompt.")
				exit(1)
			}
			if (stdinWasPiped) {
				printWarning("Use --continue without piped input.")
				exit(1)
			}

			await continueTask(options)
			return
		}

		// Error if stdin was piped but empty AND no prompt was provided
		// This handles:
		// - `echo "" | dirac` -> error (empty stdin, no prompt)
		// - `dirac "prompt"` in GitHub Actions -> OK (empty stdin ignored, has prompt)
		// - `cat file | dirac "explain"` -> OK (has stdin AND prompt)
		if (stdinInput === "" && !prompt) {
			printWarning("Empty input received from stdin. Please provide content to process.")
			exit(1)
		}

		// If no prompt argument, check if input is piped via stdin
		let effectivePrompt = prompt
		if (stdinInput) {
			if (effectivePrompt) {
				// Prepend stdin content to the prompt
				effectivePrompt = `${stdinInput}\n\n${effectivePrompt}`
			} else {
				effectivePrompt = stdinInput
			}

			// Debug: show that we received piped input
			if (options.verbose) {
				process.stderr.write(`[debug] Received ${stdinInput.length} bytes from stdin\n`)
			}
		}

		// Handle --taskId flag to resume an existing task
		if (options.taskId) {
			await resumeTask(options.taskId, {
				...options,
				initialPrompt: effectivePrompt,
				stdinWasPiped,
			})
			return
		}

		if (effectivePrompt) {
			// Pass stdinWasPiped flag so runTask knows to use plain text mode
			await runTask(effectivePrompt, { ...options, stdinWasPiped })
		} else {
			// Show welcome prompt if no prompt given
			await showWelcome(options)
		}
	})

// Parse and run
if (process.env.VITEST !== "true") {
	program.parse()
}
