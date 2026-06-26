import { getDistinctId } from "@/services/logging/distinctId"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { diracTelemetryConfig } from "../../../shared/services/config/dirac-telemetry-config"
import type { FeatureFlagsAndPayloads, FeatureFlagsSettings, IFeatureFlagsProvider } from "./IFeatureFlagsProvider"
import { jsonHeaders } from "@shared/net"

/**
 * Dirac implementation of the feature flags provider interface
 * Handles Dirac-specific feature flag retrieval
 */
export class DiracFeatureFlagsProvider implements IFeatureFlagsProvider {
	private settings: FeatureFlagsSettings

	constructor() {
		// Initialize feature flags settings
		this.settings = {
			enabled: true,
			timeout: 5000, // 5 second timeout for feature flag requests
		}
	}

	private get distinctId(): string {
		return getDistinctId()
	}

	async getAllFlagsAndPayloads(options: { flagKeys?: string[] }): Promise<FeatureFlagsAndPayloads | undefined> {
		if (!this.isEnabled() || !diracTelemetryConfig.apiKey) {
			return undefined
		}

		try {
			const response = await fetch(`${diracTelemetryConfig.host}/decide`, {
				method: "POST",
				headers: {
					...jsonHeaders(),
					"X-Dirac-API-Key": diracTelemetryConfig.apiKey,
				},
				body: JSON.stringify({
					distinctId: this.distinctId,
					options,
				}),
			})

			if (!response.ok) {
				throw new Error(`Failed to fetch feature flags: ${response.statusText}`)
			}

			return (await response.json()) as FeatureFlagsAndPayloads
		} catch (error) {
			Logger.error(`Error getting feature flags`, error)
			return {}
		}
	}

	public isEnabled(): boolean {
		return this.settings.enabled
	}

	public getSettings(): FeatureFlagsSettings {
		return { ...this.settings }
	}

	public async dispose(): Promise<void> {
		// No-op
	}
}
