/**
 * Captures CLI subagent telemetry: toggle events and execution outcomes.
 * Extracted from TelemetryService to enforce SRP — subagent-domain events are isolated from other domains.
 */
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"
import type { TelemetryCategoryGate } from "./TelemetryCategoryGate"

export class SubagentTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.TASK

	constructor(
		private readonly emitter: TelemetryEventEmitter,
		private readonly categoryGate: TelemetryCategoryGate,
	) {}

	captureSubagentToggle(enabled: boolean): void {
		if (!this.categoryGate.isEnabled("subagents")) {
			return
		}
		this.emitter.capture({
			event: enabled ? SubagentTelemetry.EVENTS.SUBAGENT_ENABLED : SubagentTelemetry.EVENTS.SUBAGENT_DISABLED,
			properties: { enabled, timestamp: new Date().toISOString() },
		})
	}

	captureSubagentExecution(ulid: string, durationMs: number, outputLines: number, success: boolean): void {
		if (!this.categoryGate.isEnabled("subagents")) {
			return
		}
		this.emitter.capture({
			event: success ? SubagentTelemetry.EVENTS.SUBAGENT_COMPLETED : SubagentTelemetry.EVENTS.SUBAGENT_STARTED,
			properties: { ulid, durationMs, outputLines, success, timestamp: new Date().toISOString() },
		})
	}
}
