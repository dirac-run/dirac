import { jsonHeaders } from "@shared/net"
import * as http from "http"
import { URL } from "url"
import { fetch, isAuthError } from "@/shared/net"
import type { OAuthTokenManager } from "./OAuthTokenManager"
import {
	buildAuthorizationUrl,
	buildDeviceAuthUnavailableError,
	deviceAuthorizationResponseSchema,
	deviceTokenResponseSchema,
	exchangeCodeForTokens,
	exchangeCodeForTokensWithRedirectUri,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState,
	OPENAI_CODEX_OAUTH_CONFIG,
	type OpenAiCodexCredentials,
	type OpenAiCodexDeviceAuthorization,
	parseOAuthErrorDetails,
	waitForDevicePollInterval,
} from "./oauth-shared"

/**
 * OAuthFlowHandler - Owns the authorization code flow (both device-code and
 * browser callback variants). Persists resulting credentials via OAuthTokenManager.
 */
export class OAuthFlowHandler {
	private pendingAuth: {
		codeVerifier: string
		state: string
		server?: http.Server
	} | null = null

	constructor(private readonly tokenManager: OAuthTokenManager) {}

	/**
	 * Initiate OAuth device-code authentication for remote/headless CLI environments.
	 */
	async initiateDeviceFlow(): Promise<OpenAiCodexDeviceAuthorization> {
		const body = JSON.stringify({
			client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		})

		const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.deviceAuthorizationEndpoint, {
			method: "POST",
			headers: {
				...jsonHeaders(),
			},
			body,
			signal: AbortSignal.timeout(30000),
		})

		if (!response.ok) {
			const errorText = await response.text()
			const { errorCode, errorMessage } = parseOAuthErrorDetails(errorText)
			if (
				response.status === 404 ||
				/unsupported|disabled|not[_ -]?enabled|device/i.test(`${errorCode ?? ""} ${errorMessage ?? ""}`)
			) {
				throw buildDeviceAuthUnavailableError()
			}
			const details = errorMessage ? errorMessage : errorText
			throw new Error(
				`Device authorization failed: ${response.status} ${response.statusText}${details ? ` - ${details}` : ""}`,
			)
		}

		const data = await response.json()
		const parsed = deviceAuthorizationResponseSchema.parse(data)
		return {
			device_code: parsed.device_auth_id,
			user_code: parsed.user_code,
			verification_uri: "https://auth.openai.com/codex/device",
			interval: parsed.interval,
		}
	}

	/**
	 * Poll the token endpoint until the user completes device-code authentication.
	 */
	async pollForDeviceToken(
		deviceCode: string,
		userCode: string,
		interval: number,
		signal?: AbortSignal,
		expiresInMs: number = 15 * 60 * 1000,
	): Promise<OpenAiCodexCredentials> {
		let currentInterval = interval
		const expiresAt = Date.now() + expiresInMs

		while (true) {
			if (signal?.aborted) {
				throw new Error("Device authentication was cancelled.")
			}

			const body = JSON.stringify({
				device_auth_id: deviceCode,
				user_code: userCode,
			})

			// Use a per-request timeout signal if no overall signal is provided
			const fetchSignal = signal ?? AbortSignal.timeout(30000)
			const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.deviceTokenEndpoint, {
				method: "POST",
				headers: {
					...jsonHeaders(),
				},
				body,
				signal: fetchSignal,
			})

			const responseText = await response.text()
			let data: unknown
			try {
				data = responseText ? JSON.parse(responseText) : {}
			} catch {
				throw new Error(`Device token polling failed: ${response.status} ${response.statusText} - ${responseText}`)
			}

			const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
			const error = typeof obj.error === "string" ? obj.error : undefined
			const errorDescription = typeof obj.error_description === "string" ? obj.error_description : undefined

			if (response.ok && !error) {
				const deviceTokenResponse = deviceTokenResponseSchema.parse(data)
				const credentials = await exchangeCodeForTokensWithRedirectUri(
					deviceTokenResponse.authorization_code,
					deviceTokenResponse.code_verifier,
					OPENAI_CODEX_OAUTH_CONFIG.deviceRedirectUri,
				)
				await this.tokenManager.saveCredentials(credentials)
				return credentials
			}

			if (isAuthError(response.status) || response.status === 404 || error === "authorization_pending") {
				if (Date.now() >= expiresAt) {
					throw new Error("The device code has expired. Please try again.")
				}
				// Safety: ensure we don't loop too fast if interval is 0
				await waitForDevicePollInterval(Math.max(currentInterval, 0.1), signal)
				continue
			}

			if (error === "slow_down") {
				currentInterval += 5
				await waitForDevicePollInterval(Math.max(currentInterval, 0.1), signal)
				continue
			}

			if (error === "expired_token") {
				throw new Error("The device code has expired. Please try again.")
			}

			if (error === "access_denied") {
				throw new Error("Access denied by user.")
			}

			if (/unsupported|disabled|not[_ -]?enabled|device/i.test(`${error ?? ""} ${errorDescription ?? ""}`)) {
				throw buildDeviceAuthUnavailableError()
			}

			throw new Error(`OAuth error: ${errorDescription || error || responseText}`)
		}
	}

	/**
	 * Start the OAuth authorization flow
	 * Returns the authorization URL to open in browser
	 */
	startAuthorizationFlow(): string {
		// Cancel any existing authorization flow before starting a new one
		this.cancelAuthorizationFlow()

		const codeVerifier = generateCodeVerifier()
		const codeChallenge = generateCodeChallenge(codeVerifier)
		const state = generateState()

		this.pendingAuth = {
			codeVerifier,
			state,
		}

		return buildAuthorizationUrl(codeChallenge, state)
	}

	/**
	 * Start a local server to receive the OAuth callback
	 * Returns a promise that resolves when authentication is complete
	 */
	async waitForCallback(): Promise<OpenAiCodexCredentials> {
		if (!this.pendingAuth) {
			throw new Error("No pending authorization flow")
		}

		// Close any existing server before starting a new one
		if (this.pendingAuth.server) {
			try {
				this.pendingAuth.server.close()
			} catch {
				// Ignore errors when closing
			}
			this.pendingAuth.server = undefined
		}

		return new Promise((resolve, reject) => {
			const server = http.createServer(async (req, res) => {
				try {
					const url = new URL(req.url || "", `http://localhost:${OPENAI_CODEX_OAUTH_CONFIG.callbackPort}`)

					if (url.pathname !== "/auth/callback") {
						res.writeHead(404)
						res.end("Not Found")
						return
					}

					const code = url.searchParams.get("code")
					const state = url.searchParams.get("state")
					const error = url.searchParams.get("error")

					if (error) {
						res.writeHead(400)
						res.end(`Authentication failed: ${error}`)
						reject(new Error(`OAuth error: ${error}`))
						server.close()
						return
					}

					if (!code || !state) {
						res.writeHead(400)
						res.end("Missing code or state parameter")
						reject(new Error("Missing code or state parameter"))
						server.close()
						return
					}

					if (state !== this.pendingAuth?.state) {
						res.writeHead(400)
						res.end("State mismatch - possible CSRF attack")
						reject(new Error("State mismatch"))
						server.close()
						return
					}

					try {
						// Note: state is validated above but not passed to exchangeCodeForTokens
						// per the implementation guide (OpenAI rejects it)
						const credentials = await exchangeCodeForTokens(code, this.pendingAuth.codeVerifier)

						await this.tokenManager.saveCredentials(credentials)

						res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
						res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authentication Successful</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: #fff;
  }
  .container { text-align: center; padding: 48px; max-width: 420px; }
  .icon {
    width: 72px; height: 72px; margin: 0 auto 24px;
    background: linear-gradient(135deg, #10a37f 0%, #1a7f64 100%);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
  }
  .icon svg { width: 36px; height: 36px; stroke: #fff; stroke-width: 3; fill: none; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 12px; }
  p { font-size: 15px; color: rgba(255,255,255,0.7); line-height: 1.5; }
  .closing { margin-top: 32px; font-size: 13px; color: rgba(255,255,255,0.5); }
</style>
</head>
<body>
<div class="container">
  <div class="icon">
    <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
  </div>
  <h1>Authentication Successful</h1>
  <p>You're now signed in to OpenAI Codex. You can close this window and return to your IDE.</p>
  <p class="closing">This window will close automatically...</p>
</div>
<script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`)

						this.pendingAuth = null
						server.close()
						resolve(credentials)
					} catch (exchangeError) {
						res.writeHead(500)
						res.end(`Token exchange failed: ${exchangeError}`)
						reject(exchangeError)
						server.close()
					}
				} catch (err) {
					res.writeHead(500)
					res.end("Internal server error")
					reject(err)
					server.close()
				}
			})

			// Set a timeout for the callback
			const timeout = setTimeout(
				() => {
					server.close()
					reject(new Error("Authentication timed out"))
				},
				5 * 60 * 1000,
			) // 5 minutes

			// Clear timeout when server closes or errors
			server.on("close", () => clearTimeout(timeout))
			server.on("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(timeout)
				this.pendingAuth = null
				if (err.code === "EADDRINUSE") {
					reject(
						new Error(
							`Port ${OPENAI_CODEX_OAUTH_CONFIG.callbackPort} is already in use. ` +
								`Please close any other applications using this port and try again.`,
						),
					)
				} else {
					reject(err)
				}
			})

			// Store server reference before listen to avoid race with cancelAuthorizationFlow
			if (this.pendingAuth) {
				this.pendingAuth.server = server
			}
			server.listen(OPENAI_CODEX_OAUTH_CONFIG.callbackPort)
		})
	}

	/**
	 * Cancel any pending authorization flow
	 */
	cancelAuthorizationFlow(): void {
		if (this.pendingAuth?.server) {
			this.pendingAuth.server.close()
		}
		this.pendingAuth = null
	}
}
