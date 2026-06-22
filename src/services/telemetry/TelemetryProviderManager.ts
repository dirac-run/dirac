/**
 * Manages telemetry provider registration, lifecycle, and dispatch of user identification.
 * Extracted from TelemetryService to enforce SRP — provider management is separate from event capture.
 */
import { Logger } from "@/shared/services/Logger"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "./providers/ITelemetryProvider"

export class TelemetryProviderManager {
	private providers: ITelemetryProvider[]

	constructor(providers: ITelemetryProvider[]) {
		this.providers = providers
	}

	addProvider(provider: ITelemetryProvider): void {
		this.providers.push(provider)
	}

	removeProvider(name: string): void {
		this.providers = this.providers.filter((p) => p.name !== name)
	}

	getProviders(): ITelemetryProvider[] {
		return [...this.providers]
	}

	isEnabled(): boolean {
		return this.providers.some((provider) => provider.isEnabled())
	}

	getSettings(): TelemetrySettings {
		return this.providers.length > 0
			? this.providers[0].getSettings()
			: { hostEnabled: false, level: "off" as const }
	}

	/** Dispatches user identification to all providers with error isolation. */
	identifyUser(userInfo: any, attributes: TelemetryProperties): void {
		this.providers.forEach((provider) => {
			try {
				provider.identifyUser(userInfo, attributes)
			} catch (error) {
				Logger.error(`[TelemetryService] identifyUser failed for provider ${provider.name}:`, error)
			}
		})
	}

	/** Returns the raw provider array for internal dispatch (event emitter uses this). */
	getProviderList(): ITelemetryProvider[] {
		return this.providers
	}

	async dispose(): Promise<void> {
		const disposePromises = this.providers.map((provider) => provider.dispose())
		await Promise.allSettled(disposePromises)
	}
}
