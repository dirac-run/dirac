import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { getDistinctId } from "@/services/logging/distinctId"
import { fetch } from "@/shared/net"
import { Setting } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import * as pkg from "../../../../package.json"
import { diracTelemetryConfig, DiracTelemetryClientValidConfig } from "../../../shared/services/config/dirac-telemetry-config"
import { getErrorLevelFromString } from ".."
import { DiracError } from "../DiracError"
import type { ErrorSettings, IErrorProvider } from "./IErrorProvider"
import { isDev } from "@shared/config/environment"
import { jsonHeaders } from "@shared/net"



type DiracErrorClientConfig = DiracTelemetryClientValidConfig & {
	enableExceptionAutocapture: boolean
}

/**
 * Dirac implementation of the error provider interface
 * Handles Dirac-specific error tracking and logging
 */
export class DiracErrorProvider implements IErrorProvider {
	private errorSettings: ErrorSettings

	constructor(_clientConfig: DiracErrorClientConfig) {
		// Initialize error settings
		this.errorSettings = {
			enabled: true,
			hostEnabled: true,
			level: "all",
		}
	}

	public async initialize(): Promise<DiracErrorProvider> {
		// Listen for host telemetry changes
		HostProvider.env.subscribeToTelemetrySettings(
			{},
			{
				onResponse: (event: { isEnabled: Setting }) => {
					const hostEnabled = event.isEnabled === Setting.ENABLED || event.isEnabled === Setting.UNSUPPORTED
					this.errorSettings.hostEnabled = hostEnabled
				},
			},
		)

		const hostSettings = await HostProvider.env.getTelemetrySettings({})
		if (hostSettings.isEnabled === Setting.DISABLED) {
			this.errorSettings.hostEnabled = false
		}

		this.errorSettings.level = getErrorLevelFromString(hostSettings.errorLevel)

		return this
	}

	async captureException(error: Error | DiracError, properties?: Record<string, unknown>): Promise<void> {
		if (!this.isEnabled() || this.errorSettings.level === "off") {
			return
		}

		const errorDetails = {
			name: error.name,
			message: error.message,
			stack: error.stack,
			extension_version: pkg.version,
			is_dev: isDev(),
			...properties,
		}

		return this.sendToDirac("extension.error", errorDetails)
	}

	public logException(error: Error | DiracError, properties: Record<string, unknown> = {}): void {
		if (!this.isEnabled() || this.errorSettings.level === "off") {
			return
		}

		const errorDetails = {
			message: error.message,
			stack: error.stack,
			name: error.name,
			extension_version: pkg.version,
			is_dev: isDev(),
			...properties,
		}

		if (error instanceof DiracError) {
			Object.assign(errorDetails, {
				modelId: error.modelId,
				providerId: error.providerId,
				serialized_error: error.serialize(),
			})
		}

		this.sendToDirac("extension.error", {
			error_type: "exception",
			...errorDetails,
		})

		Logger.error("[DiracErrorProvider] Logging exception", error)
	}

	public logMessage(
		message: string,
		level: "error" | "warning" | "log" | "debug" | "info" = "log",
		properties: Record<string, unknown> = {},
	): void {
		if (!this.isEnabled() || this.errorSettings.level === "off") {
			return
		}

		// Filter messages based on error level
		if (this.errorSettings.level === "error" && level !== "error") {
			return
		}

		this.sendToDirac("extension.message", {
			message: message.substring(0, 500), // Truncate long messages
			level,
			extension_version: pkg.version,
			is_dev: isDev(),
			...properties,
		})
	}

	private async sendToDirac(event: string, properties: Record<string, unknown>) {
		if (!diracTelemetryConfig.apiKey) {
			return
		}

		try {
			await fetch(diracTelemetryConfig.host, {
				method: "POST",
				headers: {
					...jsonHeaders(),
					"X-Dirac-API-Key": diracTelemetryConfig.apiKey,
				},
				body: JSON.stringify({
					distinctId: getDistinctId(),
					event,
					properties: {
						...properties,
						timestamp: new Date().toISOString(),
					},
				}),
			})
		} catch (error) {
			Logger.error(`Failed to send error telemetry to Dirac: ${event}`, error)
		}
	}

	public isEnabled(): boolean {
		return StateManager.get().getGlobalSettingsKey("telemetrySetting") !== "disabled" && this.errorSettings.hostEnabled
	}

	public getSettings(): ErrorSettings {
		return { ...this.errorSettings }
	}

	public async dispose(): Promise<void> {
		// No-op
	}
}
