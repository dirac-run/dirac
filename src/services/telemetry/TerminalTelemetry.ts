/**
 * Captures terminal execution telemetry: execution outcomes, output failures, user interventions, and hangs.
 * Extracted from TelemetryService to enforce SRP — terminal-domain events are isolated from other domains.
 */

import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type {
	TerminalHangStage,
	TerminalOutputFailureReason,
	TerminalOutputMethod,
	TerminalType,
	TerminalUserInterventionAction,
} from "./TelemetryTypes"

export class TerminalTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.TASK

	constructor(private readonly emitter: TelemetryEventEmitter) {}

	captureTerminalExecution(
		success: boolean,
		terminalType: TerminalType,
		method: TerminalOutputMethod,
		exitCode?: number | null,
	): void {
		this.emitter.capture({
			event: TerminalTelemetry.EVENTS.TERMINAL_EXECUTION,
			properties: {
				success,
				terminalType,
				method,
				// Only include exitCode for standalone terminals when it's a meaningful value
				...(terminalType === "standalone" && exitCode !== undefined && exitCode !== null && { exitCode }),
			},
		})
	}

	captureTerminalOutputFailure(reason: TerminalOutputFailureReason, terminalType: TerminalType = "vscode"): void {
		this.emitter.capture({
			event: TerminalTelemetry.EVENTS.TERMINAL_OUTPUT_FAILURE,
			properties: { reason, terminalType },
		})
	}

	captureTerminalUserIntervention(action: TerminalUserInterventionAction, terminalType: TerminalType = "vscode"): void {
		this.emitter.capture({
			event: TerminalTelemetry.EVENTS.TERMINAL_USER_INTERVENTION,
			properties: { action, terminalType },
		})
	}

	captureTerminalHang(stage: TerminalHangStage, terminalType: TerminalType = "vscode"): void {
		this.emitter.capture({
			event: TerminalTelemetry.EVENTS.TERMINAL_HANG,
			properties: { stage, terminalType },
		})
	}
}
