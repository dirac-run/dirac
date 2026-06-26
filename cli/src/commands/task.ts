import { exit } from "node:process"
import type { CliContext, TaskOptions } from "../types"
import { setIsPlainTextMode } from "../utils/state"
import { disposeCliContext, drainStdout, createInkCleanup } from "../utils/cleanup"
import { getPlainTextModeReason, shouldUsePlainTextMode } from "../utils/mode"
import { applyTaskOptions } from "../utils/options"
import { initializeCli } from "../init"
import { runInkApp } from "../utils/ink"

/**
 * Run a task in plain text mode (no Ink UI).
 * Handles auth check, task execution, cleanup, and exit.
 */
export async function runTaskInPlainTextMode(
	ctx: CliContext,
	options: TaskOptions,
	taskConfig: {
		prompt?: string
		taskId?: string
		imageDataUrls?: string[]
	},
): Promise<never> {
	const { isAuthConfigured } = await import("../utils/auth")
	const { printWarning } = await import("../utils/display")
	const { telemetryService } = await import("@/services/telemetry")
	const { runPlainTextTask } = await import("../utils/plain-text-task")

	// Set flag so shutdown handler knows not to clear Ink UI lines
	setIsPlainTextMode(true)

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
 * Run a task with the given prompt - uses welcome view for consistent behavior
 */
export async function runTask(prompt: string, options: TaskOptions & { images?: string[] }, existingContext?: CliContext) {
	const { parseImagesFromInput, processImagePaths } = await import("../utils/parser")
	const { telemetryService } = await import("@/services/telemetry")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { checkRawModeSupport } = await import("../context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("../components/App")

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
