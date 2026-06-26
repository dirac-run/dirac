/**
 * attachProcessListeners - Attaches all EventEmitter listeners to a TerminalProcessResultPromise.
 *
 * Strategy 5: process passed directly as function parameter, never via context object wrapper.
 */

import { TerminalHangStage, telemetryService } from "@/services/telemetry"
import type { TaskMessenger } from "../../core/task/TaskMessenger"
import { COMPLETION_TIMEOUT_MS } from "./constants"
import type { TerminalCompletionDetails, TerminalProcessResultPromise } from "./types"

export interface ListenerConfig {
	process: TerminalProcessResultPromise
	taskMessenger: TaskMessenger
	terminalType: "vscode" | "standalone"
	showShellIntegrationSuggestion?: boolean
}

/**
 * Attaches completion and shell integration listeners to process.
 * Returns a cleanup function and the current completion state accessor.
 */
export function attachProcessListeners(
	config: ListenerConfig,
	onCompleted: (details?: TerminalCompletionDetails) => void,
): { cleanup: () => void; getCompletionState: () => { completed: boolean; details?: TerminalCompletionDetails } } {
	const { process, taskMessenger, terminalType, showShellIntegrationSuggestion } = config

	let completionTimer: NodeJS.Timeout | null = null
	let completed = false
	let completionDetails: TerminalCompletionDetails | undefined

	const onCompletedHandler = async (details?: TerminalCompletionDetails) => {
		completed = true
		completionDetails = details
		if (completionTimer) {
			clearTimeout(completionTimer)
			completionTimer = null
		}
		onCompleted(details)
	}

	const onShellIntegrationHandler = async () => {
		if (showShellIntegrationSuggestion) {
			await taskMessenger.upsertText(
				"Shell integration is not available. Consider using background execution mode for better performance.",
			)
		} else {
			await taskMessenger.upsertText("Shell integration is not available.")
		}
	}

	completionTimer = setTimeout(() => {
		if (!completed) {
			telemetryService.captureTerminalHang(TerminalHangStage.WAITING_FOR_COMPLETION, terminalType)
			completionTimer = null
		}
	}, COMPLETION_TIMEOUT_MS)

	process.once("completed", onCompletedHandler)
	process.once("no_shell_integration", onShellIntegrationHandler)

	const cleanup = () => {
		if (completionTimer) clearTimeout(completionTimer)
	}

	return {
		cleanup,
		getCompletionState: () => ({ completed, details: completionDetails }),
	}
}
