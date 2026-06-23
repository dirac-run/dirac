/**
 * Owns the per-category telemetry enable/disable flags.
 * Extracted from TelemetryService to enforce SRP — category gating is separate from event capture.
 */
import type { TelemetryCategory } from "./TelemetryTypes"

export class TelemetryCategoryGate {
	private readonly enabled: Map<TelemetryCategory, boolean> = new Map([
		["checkpoints", true],
		["browser", true],
		["subagents", true],
		["skills", true],
		["hooks", true],
	])

	/** Returns true unless the category was explicitly disabled. */
	isEnabled(category: TelemetryCategory): boolean {
		return this.enabled.get(category) ?? true
	}

	setEnabled(category: TelemetryCategory, enabled: boolean): void {
		this.enabled.set(category, enabled)
	}
}
