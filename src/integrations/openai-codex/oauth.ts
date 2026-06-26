import { OAuthFlowHandler } from "./OAuthFlowHandler"
import { OAuthTokenManager } from "./OAuthTokenManager"
import type { OpenAiCodexCredentials, OpenAiCodexDeviceAuthorization } from "./oauth-shared"

// Re-export the public API surface so existing imports keep working.
export {
	buildAuthorizationUrl,
	exchangeCodeForTokens,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState,
	isTokenExpired,
	OPENAI_CODEX_OAUTH_CONFIG,
	type OpenAiCodexCredentials,
	type OpenAiCodexDeviceAuthorization,
	refreshAccessToken,
} from "./oauth-shared"

/**
 * OpenAiCodexOAuthManager - Public facade combining token management and the
 * authorization code flow. Delegates to OAuthTokenManager (storage/refresh) and
 * OAuthFlowHandler (device + browser flows) without adding behavior.
 */
export class OpenAiCodexOAuthManager {
	private readonly tokenManager: OAuthTokenManager
	private readonly flowHandler: OAuthFlowHandler

	constructor() {
		this.tokenManager = new OAuthTokenManager()
		this.flowHandler = new OAuthFlowHandler(this.tokenManager)
	}

	async forceRefreshAccessToken(): Promise<string | null> {
		return this.tokenManager.forceRefreshAccessToken()
	}

	async loadCredentials(): Promise<OpenAiCodexCredentials | null> {
		return this.tokenManager.loadCredentials()
	}

	async saveCredentials(credentials: OpenAiCodexCredentials): Promise<void> {
		return this.tokenManager.saveCredentials(credentials)
	}

	async clearCredentials(): Promise<void> {
		return this.tokenManager.clearCredentials()
	}

	async getAccessToken(): Promise<string | null> {
		return this.tokenManager.getAccessToken()
	}

	async getEmail(): Promise<string | null> {
		return this.tokenManager.getEmail()
	}

	async getAccountId(): Promise<string | null> {
		return this.tokenManager.getAccountId()
	}

	async isAuthenticated(): Promise<boolean> {
		return this.tokenManager.isAuthenticated()
	}

	async initiateDeviceFlow(): Promise<OpenAiCodexDeviceAuthorization> {
		return this.flowHandler.initiateDeviceFlow()
	}

	async pollForDeviceToken(
		deviceCode: string,
		userCode: string,
		interval: number,
		signal?: AbortSignal,
		expiresInMs?: number,
	): Promise<OpenAiCodexCredentials> {
		return this.flowHandler.pollForDeviceToken(deviceCode, userCode, interval, signal, expiresInMs)
	}

	startAuthorizationFlow(): string {
		return this.flowHandler.startAuthorizationFlow()
	}

	async waitForCallback(): Promise<OpenAiCodexCredentials> {
		return this.flowHandler.waitForCallback()
	}

	cancelAuthorizationFlow(): void {
		this.flowHandler.cancelAuthorizationFlow()
	}

	getCredentials(): OpenAiCodexCredentials | null {
		return this.tokenManager.getCredentials()
	}
}

// Singleton instance
export const openAiCodexOAuthManager = new OpenAiCodexOAuthManager()
