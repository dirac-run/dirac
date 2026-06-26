import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import {
	isTokenExpired,
	OPENAI_CODEX_CREDENTIALS_KEY,
	type OpenAiCodexCredentials,
	OpenAiCodexOAuthTokenError,
	openAiCodexCredentialsSchema,
	refreshAccessToken,
} from "./oauth-shared"

/**
 * OAuthTokenManager - Owns credential storage, token refresh, and credential access.
 * De-duplicates concurrent refreshes and clears stored secrets when a refresh token
 * is clearly invalid/revoked.
 */
export class OAuthTokenManager {
	private credentials: OpenAiCodexCredentials | null = null
	private refreshPromise: Promise<OpenAiCodexCredentials> | null = null

	/**
	 * Force a refresh using the stored refresh token even if the access token is not expired.
	 * Useful when the server invalidates an access token early.
	 */
	async forceRefreshAccessToken(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}

		if (!this.credentials) {
			return null
		}

		try {
			// De-dupe concurrent refreshes
			if (!this.refreshPromise) {
				this.refreshPromise = refreshAccessToken(this.credentials)
			}

			const newCredentials = await this.refreshPromise
			this.refreshPromise = null
			await this.saveCredentials(newCredentials)
			return newCredentials.access_token
		} catch (error) {
			this.refreshPromise = null
			Logger.error("[openai-codex-oauth] Failed to force refresh token:", error)
			if (error instanceof OpenAiCodexOAuthTokenError && error.isLikelyInvalidGrant()) {
				Logger.log("[openai-codex-oauth] Refresh token appears invalid; clearing stored credentials")
				await this.clearCredentials()
			}
			return null
		}
	}

	/**
	 * Load credentials from storage via StateManager.
	 */
	async loadCredentials(): Promise<OpenAiCodexCredentials | null> {
		try {
			const stateManager = StateManager.get()
			const credentialsJson = stateManager.getSecretKey(OPENAI_CODEX_CREDENTIALS_KEY)

			if (!credentialsJson) {
				return null
			}

			const parsed = JSON.parse(credentialsJson)
			this.credentials = openAiCodexCredentialsSchema.parse(parsed)
			return this.credentials
		} catch (error) {
			Logger.error("[openai-codex-oauth] Failed to load credentials:", error)
			return null
		}
	}

	/**
	 * Save credentials to storage via StateManager
	 */
	async saveCredentials(credentials: OpenAiCodexCredentials): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setSecret(OPENAI_CODEX_CREDENTIALS_KEY, JSON.stringify(credentials))
		await stateManager.flushPendingState()
		this.credentials = credentials
	}

	/**
	 * Clear credentials from storage
	 */
	async clearCredentials(): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setSecret(OPENAI_CODEX_CREDENTIALS_KEY, undefined)
		await stateManager.flushPendingState()
		this.credentials = null
	}

	/**
	 * Get a valid access token, refreshing if necessary
	 */
	async getAccessToken(): Promise<string | null> {
		// Try to load credentials if not already loaded
		if (!this.credentials) {
			await this.loadCredentials()
		}

		if (!this.credentials) {
			return null
		}

		// Check if token is expired and refresh if needed
		if (isTokenExpired(this.credentials)) {
			try {
				// De-dupe concurrent refreshes
				if (!this.refreshPromise) {
					this.refreshPromise = refreshAccessToken(this.credentials)
				}

				const newCredentials = await this.refreshPromise
				this.refreshPromise = null
				await this.saveCredentials(newCredentials)
			} catch (error) {
				this.refreshPromise = null
				Logger.error("[openai-codex-oauth] Failed to refresh token:", error)

				// Only clear secrets when the refresh token is clearly invalid/revoked.
				if (error instanceof OpenAiCodexOAuthTokenError && error.isLikelyInvalidGrant()) {
					Logger.log("[openai-codex-oauth] Refresh token appears invalid; clearing stored credentials")
					await this.clearCredentials()
				}
				return null
			}
		}

		return this.credentials.access_token
	}

	/**
	 * Get the user's email from credentials
	 */
	async getEmail(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.email || null
	}

	/**
	 * Get the ChatGPT account ID from credentials
	 * Used for the ChatGPT-Account-Id header required by the Codex API
	 */
	async getAccountId(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.accountId || null
	}

	/**
	 * Check if the user has stored credentials (i.e. has completed auth).
	 * This intentionally does NOT attempt a token refresh so that transient
	 * network failures or expired-but-refreshable tokens don't cause the
	 * CLI to bounce the user back to the onboarding flow.
	 */
	async isAuthenticated(): Promise<boolean> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials !== null
	}

	/**
	 * Get the current credentials (for display purposes)
	 */
	getCredentials(): OpenAiCodexCredentials | null {
		return this.credentials
	}
}
