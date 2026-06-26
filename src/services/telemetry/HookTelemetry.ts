/**
 * Captures hook telemetry: execution lifecycle, cache access, and discovery.
 * Extracted from TelemetryService to enforce SRP — hook-domain events are isolated from other domains.
 */
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"
import { TELEMETRY_METRICS } from "./TelemetryMetrics"
import type { TelemetryCategoryGate } from "./TelemetryCategoryGate"
import type { TelemetryProperties } from "./providers/ITelemetryProvider"

const MAX_ERROR_MESSAGE_LENGTH = 500

type HookExecutionStatus = "started" | "completed" | "failed" | "cancelled"
type HookExecutionMetadata = {
	source?: "global" | "workspace"
	toolName?: string
	durationMs?: number
	exitCode?: number
	errorType?: "timeout" | "execution" | "validation"
	errorMessage?: string
	cancelRequested?: boolean
	contextModified?: boolean
	contextSize?: number
}

export class HookTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS
	private static readonly METRICS = TELEMETRY_METRICS

	constructor(
		private readonly emitter: TelemetryEventEmitter,
		private readonly categoryGate: TelemetryCategoryGate,
	) {}

	captureHookCacheAccess(hookName: string, cacheHit: boolean): void {
		if (!this.categoryGate.isEnabled("hooks")) {
			return
		}
		this.emitter.recordCounter(HookTelemetry.METRICS.HOOKS.CACHE_ACCESSES_TOTAL, 1, { hookName, cacheHit: cacheHit.toString() })
	}

	captureHookExecution(ulid: string, hookName: string, status: HookExecutionStatus, metadata?: HookExecutionMetadata): void {
		if (!this.categoryGate.isEnabled("hooks")) {
			return
		}
		const properties: TelemetryProperties = {
			ulid,
			hookName,
			status,
			timestamp: new Date().toISOString(),
			...(metadata?.source && { source: metadata.source }),
			...(metadata?.toolName && { toolName: metadata.toolName }),
			...(metadata?.durationMs !== undefined && { durationMs: metadata.durationMs }),
			...(metadata?.exitCode !== undefined && { exitCode: metadata.exitCode }),
			...(metadata?.errorType && { errorType: metadata.errorType }),
			...(metadata?.errorMessage && { errorMessage: metadata.errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH) }),
			...(metadata?.cancelRequested !== undefined && { cancelRequested: metadata.cancelRequested }),
			...(metadata?.contextModified !== undefined && { contextModified: metadata.contextModified }),
			...(metadata?.contextSize !== undefined && { contextSize: metadata.contextSize }),
		}
		this.emitter.capture({ event: "hooks.execution", properties })
		const hookAttributes = {
			ulid,
			hookName,
			status,
			...(metadata?.source && { source: metadata.source }),
			...(metadata?.toolName && { toolName: metadata.toolName }),
		}
		if (status === "started") {
			this.emitter.recordCounter(HookTelemetry.METRICS.HOOKS.EXECUTIONS_TOTAL, 1, hookAttributes)
		} else if (status === "completed") {
			if (metadata?.durationMs !== undefined) {
				this.emitter.recordHistogram(HookTelemetry.METRICS.HOOKS.DURATION_SECONDS, metadata.durationMs / 1000, hookAttributes)
			}
			if (metadata?.cancelRequested) {
				this.emitter.recordCounter(HookTelemetry.METRICS.HOOKS.CANCELLATIONS_TOTAL, 1, hookAttributes)
			}
			if (metadata?.contextModified) {
				this.emitter.recordCounter(HookTelemetry.METRICS.HOOKS.CONTEXT_MODIFICATIONS_TOTAL, 1, hookAttributes)
			}
		} else if (status === "failed") {
			this.emitter.recordCounter(HookTelemetry.METRICS.HOOKS.FAILURES_TOTAL, 1, { ...hookAttributes, errorType: metadata?.errorType || "unknown" })
		} else if (status === "cancelled") {
			this.emitter.recordCounter(HookTelemetry.METRICS.HOOKS.CANCELLATIONS_TOTAL, 1, hookAttributes)
		}
	}

	captureHookDiscovery(hookName: string, globalCount: number, workspaceCount: number): void {
		if (!this.categoryGate.isEnabled("hooks")) {
			return
		}
		this.emitter.capture({
			event: HookTelemetry.EVENTS.HOOKS.DISCOVERY_COMPLETED,
			properties: { hookName, globalCount, workspaceCount, totalCount: globalCount + workspaceCount, timestamp: new Date().toISOString() },
		})
	}
}
