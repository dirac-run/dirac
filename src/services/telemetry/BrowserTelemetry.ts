/**
 * Captures browser automation telemetry: tool start/end, and errors during browser sessions.
 * Extracted from TelemetryService to enforce SRP — browser-domain events are isolated from other domains.
 */
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { TelemetryCategoryGate } from "./TelemetryCategoryGate"
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"

export class BrowserTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.TASK

	constructor(
		private readonly emitter: TelemetryEventEmitter,
		private readonly categoryGate: TelemetryCategoryGate,
	) {}

	captureBrowserToolStart(ulid: string, browserSettings: BrowserSettings): void {
		if (!this.categoryGate.isEnabled("browser")) {
			return
		}
		this.emitter.capture({
			event: BrowserTelemetry.EVENTS.BROWSER_TOOL_START,
			properties: {
				ulid,
				viewport: browserSettings.viewport,
				isRemote: !!browserSettings.remoteBrowserEnabled,
				remoteBrowserHost: browserSettings.remoteBrowserHost,
				timestamp: new Date().toISOString(),
			},
		})
	}

	captureBrowserToolEnd(ulid: string, stats: { actionCount: number; duration: number; actions?: string[] }): void {
		if (!this.categoryGate.isEnabled("browser")) {
			return
		}
		this.emitter.capture({
			event: BrowserTelemetry.EVENTS.BROWSER_TOOL_END,
			properties: {
				ulid,
				actionCount: stats.actionCount,
				duration: stats.duration,
				actions: stats.actions,
				timestamp: new Date().toISOString(),
			},
		})
	}

	captureBrowserError(
		ulid: string,
		errorType: string,
		errorMessage: string,
		context?: { action?: string; url?: string; isRemote?: boolean; remoteBrowserHost?: string; endpoint?: string },
	): void {
		if (!this.categoryGate.isEnabled("browser")) {
			return
		}
		this.emitter.capture({
			event: BrowserTelemetry.EVENTS.BROWSER_ERROR,
			properties: {
				ulid,
				errorType,
				errorMessage,
				...(context && { context }),
				timestamp: new Date().toISOString(),
			},
		})
	}
}
