/**
 * Dispatches telemetry events and metrics to all registered providers.
 * Extracted from TelemetryService to enforce SRP — event dispatch is separate from provider management.
 */
import { Logger } from "@/shared/services/Logger"
import type { TelemetryContextManager } from "./TelemetryContextManager"
import type { TelemetryProviderManager } from "./TelemetryProviderManager"
import type { TelemetryProperties } from "./providers/ITelemetryProvider"

export class TelemetryEventEmitter {
	constructor(
		private providerManager: TelemetryProviderManager,
		private contextManager: TelemetryContextManager,
	) {}

	/** Captures a telemetry event if telemetry is enabled, merging standard attributes. */
	capture(event: { event: string; properties?: TelemetryProperties }): void {
		const propertiesWithMetadata = this.contextManager.getStandardAttributes(event.properties)
		this.captureToProviders(event.event, propertiesWithMetadata, false)
	}

	/** Captures a required telemetry event that bypasses user opt-out settings. */
	captureRequired(event: string, properties?: TelemetryProperties): void {
		const propertiesWithMetadata = this.contextManager.getStandardAttributes(properties)
		this.captureToProviders(event, propertiesWithMetadata, true)
	}

	/** Dispatches an event to all providers with error isolation. */
	private captureToProviders(event: string, properties: TelemetryProperties, required: boolean): void {
		this.providerManager.getProviderList().forEach((provider) => {
			try {
				if (required) {
					provider.logRequired(event, properties)
				} else {
					provider.log(event, properties)
				}
			} catch (error) {
				Logger.error(`[TelemetryService] Provider failed for event ${event}:`, error)
			}
		})
	}

	recordCounter(name: string, value: number, attributes?: TelemetryProperties, description?: string, required = false): void {
		const attrs = this.contextManager.getStandardAttributes(attributes)
		this.providerManager.getProviderList().forEach((provider) => {
			try {
				provider.recordCounter(name, value, attrs, description, required)
			} catch (error) {
				Logger.error(`[TelemetryService] recordCounter failed: ${name}`, error)
			}
		})
	}

	recordHistogram(name: string, value: number, attributes?: TelemetryProperties, description?: string, required = false): void {
		const attrs = this.contextManager.getStandardAttributes(attributes)
		this.providerManager.getProviderList().forEach((provider) => {
			try {
				provider.recordHistogram(name, value, attrs, description, required)
			} catch (error) {
				Logger.error(`[TelemetryService] recordHistogram failed: ${name}`, error)
			}
		})
	}

	/**
	 * Gauge values require explicit cleanup: callers must pass null with the same attribute set
	 * when the series identified by name+attributes ends to prevent stale metric entries.
	 */
	recordGauge(
		name: string,
		value: number | null,
		attributes?: TelemetryProperties,
		description?: string,
		required = false,
	): void {
		const attrs = this.contextManager.getStandardAttributes(attributes)
		this.providerManager.getProviderList().forEach((provider) => {
			try {
				provider.recordGauge(name, value, attrs, description, required)
			} catch (error) {
				Logger.error(`[TelemetryService] recordGauge failed: ${name}`, error)
			}
		})
	}
}
