import { StateManager } from "@/core/storage/StateManager"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { z } from "zod"
import { jsonHeaders } from "@shared/net"

const CLIENT_ID = "Iv1.b507a08c87ecfe98"
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

const githubCopilotCredentialsSchema = z.object({
	type: z.literal("github-copilot"),
	access_token: z.string().min(1),
	email: z.string().optional(),
})

export type GithubCopilotCredentials = z.infer<typeof githubCopilotCredentialsSchema>

export class GithubCopilotAuthManager {
	private credentials: GithubCopilotCredentials | null = null

	async loadCredentials(): Promise<GithubCopilotCredentials | null> {
		try {
			const stateManager = StateManager.get()
			const credentialsJson = stateManager.getSecretKey("github-copilot-oauth-credentials")
			if (!credentialsJson) {
				return null
			}
			const parsed = JSON.parse(credentialsJson)
			this.credentials = githubCopilotCredentialsSchema.parse(parsed)
			return this.credentials
		} catch (error) {
			Logger.error("[github-copilot-auth] Failed to load credentials:", error)
			return null
		}
	}

	async saveCredentials(credentials: GithubCopilotCredentials): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setSecret("github-copilot-oauth-credentials", JSON.stringify(credentials))
		await stateManager.flushPendingState()
		this.credentials = credentials
	}

	async clearCredentials(): Promise<void> {
		const stateManager = StateManager.get()
		stateManager.setSecret("github-copilot-oauth-credentials", undefined)
		await stateManager.flushPendingState()
		this.credentials = null
	}

	async getEmail(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.email || null
	}

	async getAccessToken(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.access_token || null
	}

	async isAuthenticated(): Promise<boolean> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials !== null
	}

	async initiateDeviceFlow(): Promise<{
		verification_uri: string
		user_code: string
		device_code: string
		interval: number
		expires_in: number
	}> {
		const response = await fetch(GITHUB_DEVICE_CODE_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				...jsonHeaders(),
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				scope: "read:user",
			}),
		})

		if (!response.ok) {
			throw new Error(`Failed to initiate device authorization: ${response.statusText}`)
		}

		return await response.json()
	}

	async pollForToken(deviceCode: string, interval: number): Promise<GithubCopilotCredentials> {
		let currentInterval = interval
		while (true) {
			const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
				method: "POST",
				headers: {
					Accept: "application/json",
					...jsonHeaders(),
				},
				body: JSON.stringify({
					client_id: CLIENT_ID,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			})

			if (!response.ok) {
				throw new Error(`Token polling failed: ${response.statusText}`)
			}

			const data = await response.json()

			if (data.access_token) {
				// Fetch user info to get email
				let email: string | undefined
				try {
					const userResponse = await fetch("https://api.github.com/user", {
						headers: {
							Authorization: `Bearer ${data.access_token}`,
							Accept: "application/json",
						},
					})
					if (userResponse.ok) {
						const userData = await userResponse.json()
						email = userData.email || userData.login
					}
				} catch (error) {
					Logger.error("[github-copilot-auth] Failed to fetch user info:", error)
				}

				const credentials: GithubCopilotCredentials = {
					type: "github-copilot",
					access_token: data.access_token,
					email,
				}
				await this.saveCredentials(credentials)
				return credentials
			}

			if (data.error === "authorization_pending") {
				await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS))
				continue
			}

			if (data.error === "slow_down") {
				currentInterval = (data.interval || currentInterval) + 5
				await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS))
				continue
			}

			if (data.error === "expired_token") {
				throw new Error("The device code has expired. Please try again.")
			}

			if (data.error === "access_denied") {
				throw new Error("Access denied by user.")
			}

			throw new Error(`OAuth error: ${data.error_description || data.error}`)
		}
	}
}

export const githubCopilotAuthManager = new GithubCopilotAuthManager()
