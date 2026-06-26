import { exit } from "node:process"
import type { CliContext, TaskOptions } from "../types"
import { initializeCli } from "../init"
import { disposeCliContext, createInkCleanup } from "../utils/cleanup"
import { applyTaskOptions } from "../utils/options"
import { shouldUsePlainTextMode } from "../utils/mode"
import { runInkApp } from "../utils/ink"
import { findTaskInHistory } from "./history"
import { runTaskInPlainTextMode } from "./task"

/**
 * Resume an existing task by ID
 * Loads the task and optionally prefills the input with a prompt
 */
export async function resumeTask(
	taskId: string,
	options: TaskOptions & { initialPrompt?: string },
	existingContext?: CliContext,
) {
	const { printWarning, printInfo } = await import("../utils/display")
	const { telemetryService } = await import("@/services/telemetry")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { checkRawModeSupport } = await import("../context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("../components/App")

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

export async function continueTask(options: TaskOptions) {
	const { findMostRecentTaskForWorkspace } = await import("../utils/task-history")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { printWarning, printInfo } = await import("../utils/display")

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
