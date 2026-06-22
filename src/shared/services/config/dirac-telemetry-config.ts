import { BUILD_CONSTANTS } from "../../constants"
import { isTest, isDevelopmentMode } from "@shared/config/environment"

export interface DiracTelemetryClientConfig {
	/**
	 * The main API key for Dirac telemetry service.
	 */
	apiKey?: string | undefined
	/**
	 * The API key for Dirac used only for error tracking service.
	 */
	errorTrackingApiKey?: string | undefined
	enableErrorAutocapture?: boolean
	host: string
	uiHost: string
}

/**
 * Helper type for a valid Dirac client configuration.
 * Must contains api keys for both telemetry and error tracking.
 */
export interface DiracTelemetryClientValidConfig extends DiracTelemetryClientConfig {
	apiKey: string
	errorTrackingApiKey: string
}

/**
 * NOTE: Ensure that dev environment is not used in production.
 * process.env.CI will always be true in the CI environment, during both testing and publishing step,
 * so it is not a reliable indicator of the environment.
 */
const useDevEnv = isDevelopmentMode()

/**
 * Dirac telemetry configuration.
 * NOTE: The production environment variables will be injected at build time in CI/CD pipeline.
 * IMPORTANT: The secrets must be added to the GitHub Secrets and matched with the environment variables names
 * defined in the .github/workflows/publish.yml workflow.
 */
export const diracTelemetryConfig: DiracTelemetryClientConfig = {
	apiKey: BUILD_CONSTANTS.TELEMETRY_SERVICE_API_KEY || "dd5e5ac0c15eb75402dd85b4ca616da06aed2e9c7c39990923e7710129ddc238",
	errorTrackingApiKey: BUILD_CONSTANTS.ERROR_SERVICE_API_KEY || "dirac-error-key",
	host: "https://dirac.run/v1/event",
	uiHost: useDevEnv ? "https://us.i.posthog.com" : "https://us.posthog.com",
	enableErrorAutocapture: BUILD_CONSTANTS.ENABLE_ERROR_AUTOCAPTURE === "true",
}

const isTestEnv = isTest()

export function isDiracTelemetryConfigValid(config: DiracTelemetryClientConfig): config is DiracTelemetryClientValidConfig {
	// Allow invalid config in test environment to enable mocking and stubbing
	if (isTestEnv) {
		return false
	}
	return (
		typeof config.apiKey === "string" &&
		typeof config.errorTrackingApiKey === "string" &&
		typeof config.host === "string" &&
		typeof config.uiHost === "string"
	)
}
