/**
 * Captures user lifecycle, authentication, and onboarding telemetry events.
 * Extracted from TelemetryService to enforce SRP — user-domain events are separate from task/tool events.
 */
import type { TelemetryContextManager } from "./TelemetryContextManager"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryProviderManager } from "./TelemetryProviderManager"

const MAX_ERROR_MESSAGE_LENGTH = 500

export class UserTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.USER

	constructor(
		private readonly emitter: TelemetryEventEmitter,
		private readonly contextManager: TelemetryContextManager,
		private readonly providerManager: TelemetryProviderManager,
	) {}

	captureUserOptOut(): void {
		this.emitter.captureRequired(UserTelemetry.EVENTS.OPT_OUT, {})
	}

	captureUserOptIn(): void {
		this.emitter.capture({ event: UserTelemetry.EVENTS.OPT_IN })
	}

	captureExtensionActivated(): void {
		this.emitter.capture({ event: UserTelemetry.EVENTS.EXTENSION_ACTIVATED })
	}

	captureExtensionStorageError(errorMessage: string, eventName: string): void {
		this.emitter.capture({
			event: UserTelemetry.EVENTS.EXTENSION_STORAGE_ERROR,
			properties: {
				error:
					errorMessage.length > MAX_ERROR_MESSAGE_LENGTH
						? errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH) + "..."
						: errorMessage,
				eventName,
			},
		})
	}

	captureAuthStarted(provider?: string): void {
		this.emitter.capture({ event: UserTelemetry.EVENTS.AUTH_STARTED, properties: { provider } })
	}

	captureAuthSucceeded(provider?: string): void {
		this.emitter.capture({ event: UserTelemetry.EVENTS.AUTH_SUCCEEDED, properties: { provider } })
	}

	captureAuthFailed(provider?: string): void {
		this.emitter.capture({ event: UserTelemetry.EVENTS.AUTH_FAILED, properties: { provider } })
	}

	captureAuthLoggedOut(provider?: string, reason?: string): void {
		this.emitter.capture({ event: UserTelemetry.EVENTS.AUTH_LOGGED_OUT, properties: { provider, reason } })
	}

	captureOnboardingProgress(args: { step: number; action?: string; model?: string; completed?: boolean }): void {
		this.emitter.capture({ event: UserTelemetry.EVENTS.ONBOARDING_PROGRESS, properties: { ...args } })
	}

	identifyAccount(userInfo: any): void {
		if (!userInfo || !userInfo.id) {
			return
		}
		this.contextManager.setUserInfo({
			id: userInfo.id,
			organizationId: userInfo.organizationId,
			organizationName: userInfo.organizationName,
			memberId: userInfo.memberId,
		})
		this.providerManager.identifyUser(userInfo, this.contextManager.getStandardAttributes())
	}
}
