import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import { StateManager } from "@/core/storage/StateManager"
import { mockFetchForTesting } from "@/shared/net"
import {
	buildAuthorizationUrl,
	exchangeCodeForTokens,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState,
	isTokenExpired,
	OPENAI_CODEX_OAUTH_CONFIG,
	OpenAiCodexOAuthManager,
	refreshAccessToken,
} from "../oauth"
import { expectLoggerErrors } from "@/test/loggerGuard"

class TestStateManager {
	private secrets = new Map<string, string | undefined>()

	getSecretKey(key: string): string | undefined {
		return this.secrets.get(key)
	}

	setSecret(key: string, value: string | undefined): void {
		if (value === undefined) {
			this.secrets.delete(key)
			return
		}
		this.secrets.set(key, value)
	}

	async flushPendingState(): Promise<void> { }
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

function createJwt(claims: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
	return `${header}.${payload}.signature`
}

function validCredentials(
	overrides: Partial<{ access_token: string; refresh_token: string; expires: number; email: string; accountId: string }> = {},
): string {
	return JSON.stringify({
		type: "openai-codex",
		access_token: overrides.access_token ?? "access-123",
		refresh_token: overrides.refresh_token ?? "refresh-123",
		expires: overrides.expires ?? Date.now() + 3600000,
		email: overrides.email ?? "user@example.com",
		accountId: overrides.accountId ?? "account-123",
	})
}

describe("OpenAiCodexOAuthManager token management", () => {
	let stateManager: TestStateManager

	beforeEach(() => {
		stateManager = new TestStateManager()
		sinon.stub(StateManager, "get").returns(stateManager as unknown as StateManager)
	})

	afterEach(() => {
		sinon.restore()
	})

	describe("credential storage", () => {
		it("returns null and does not throw when no credentials are stored", async () => {
			const manager = new OpenAiCodexOAuthManager()
			const creds = await manager.loadCredentials()
			should(creds).be.null()
		})

		it("loads and parses stored credentials", async () => {
			stateManager.setSecret("openai-codex-oauth-credentials", validCredentials())
			const manager = new OpenAiCodexOAuthManager()
			const creds = await manager.loadCredentials()
			creds!.access_token!.should.equal("access-123")
			creds!.accountId!.should.equal("account-123")
		})

		it("returns null when stored credentials are corrupt", async () => {
			expectLoggerErrors()
			stateManager.setSecret("openai-codex-oauth-credentials", "{not json")
			const manager = new OpenAiCodexOAuthManager()
			const creds = await manager.loadCredentials()
			should(creds).be.null()
		})

		it("persists credentials via saveCredentials and exposes them via getCredentials", async () => {
			const manager = new OpenAiCodexOAuthManager()
			const creds = {
				type: "openai-codex" as const,
				access_token: "a",
				refresh_token: "r",
				expires: Date.now() + 1000,
				email: "e@example.com",
				accountId: "acc",
			}
			await manager.saveCredentials(creds)
			JSON.parse(stateManager.getSecretKey("openai-codex-oauth-credentials")!).access_token!.should.equal("a")
			manager.getCredentials()?.access_token?.should.equal("a")
		})

		it("clearCredentials removes the stored secret and resets in-memory state", async () => {
			stateManager.setSecret("openai-codex-oauth-credentials", validCredentials())
			const manager = new OpenAiCodexOAuthManager()
			await manager.loadCredentials()
			await manager.clearCredentials()
			should(stateManager.getSecretKey("openai-codex-oauth-credentials")).be.undefined()
			should(manager.getCredentials()).be.null()
		})
	})

	describe("credential accessors", () => {
		it("isAuthenticated reflects stored credentials without attempting refresh", async () => {
			stateManager.setSecret("openai-codex-oauth-credentials", validCredentials())
			const manager = new OpenAiCodexOAuthManager()
				; (await manager.isAuthenticated()).should.be.true()
		})

		it("isAuthenticated is false when nothing is stored", async () => {
			const manager = new OpenAiCodexOAuthManager()
				; (await manager.isAuthenticated()).should.be.false()
		})

		it("getEmail returns the stored email", async () => {
			stateManager.setSecret("openai-codex-oauth-credentials", validCredentials({ email: "hello@example.com" }))
			const manager = new OpenAiCodexOAuthManager()
				; ((await manager.getEmail()) as string).should.equal("hello@example.com")
		})

		it("getAccountId returns the stored accountId", async () => {
			stateManager.setSecret("openai-codex-oauth-credentials", validCredentials({ accountId: "acct-xyz" }))
			const manager = new OpenAiCodexOAuthManager()
				; ((await manager.getAccountId()) as string).should.equal("acct-xyz")
		})

		it("getEmail returns null when no email is present", async () => {
			stateManager.setSecret(
				"openai-codex-oauth-credentials",
				JSON.stringify({ type: "openai-codex", access_token: "a", refresh_token: "r", expires: Date.now() + 1000 }),
			)
			const manager = new OpenAiCodexOAuthManager()
			should(await manager.getEmail()).be.null()
		})
	})

	describe("getAccessToken refresh behavior", () => {
		it("returns the stored access token when it is not expired", async () => {
			stateManager.setSecret("openai-codex-oauth-credentials", validCredentials({ access_token: "fresh-token" }))
			const manager = new OpenAiCodexOAuthManager()
				; ((await manager.getAccessToken()) as string).should.equal("fresh-token")
		})

		it("refreshes an expired token and persists the new one", async () => {
			stateManager.setSecret(
				"openai-codex-oauth-credentials",
				validCredentials({ access_token: "old", refresh_token: "rt", expires: Date.now() - 1000 }),
			)
			const newToken = createJwt({ chatgpt_account_id: "account-123" })
			const fetchStub = sinon.stub().resolves(
				jsonResponse({
					access_token: newToken,
					refresh_token: "new-rt",
					expires_in: 3600,
				}),
			)
			const manager = new OpenAiCodexOAuthManager()

			const token = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				manager.getAccessToken(),
			)

			should(token).equal(newToken)
			const stored = JSON.parse(stateManager.getSecretKey("openai-codex-oauth-credentials")!)
			stored.access_token!.should.equal(newToken)
			stored.refresh_token!.should.equal("new-rt")

			const [url, init] = fetchStub.firstCall.args as [string, RequestInit]
			url.should.equal(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint)
			const body = new URLSearchParams(init.body as string)
			body.get("grant_type")?.should.equal("refresh_token")
			body.get("refresh_token")?.should.equal("rt")
		})

		it("returns null and clears credentials when refresh fails with invalid_grant", async () => {
			expectLoggerErrors()
			stateManager.setSecret(
				"openai-codex-oauth-credentials",
				validCredentials({ refresh_token: "bad", expires: Date.now() - 1000 }),
			)
			const fetchStub = sinon.stub().resolves(jsonResponse({ error: "invalid_grant", error_description: "revoked" }, 400))
			const manager = new OpenAiCodexOAuthManager()

			const token = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				manager.getAccessToken(),
			)

			should(token).be.null()
			should(stateManager.getSecretKey("openai-codex-oauth-credentials")).be.undefined()
		})

		it("returns null but keeps credentials when refresh fails with a transient error", async () => {
			expectLoggerErrors()
			stateManager.setSecret(
				"openai-codex-oauth-credentials",
				validCredentials({ refresh_token: "rt", expires: Date.now() - 1000 }),
			)
			const fetchStub = sinon.stub().resolves(jsonResponse({ error: "server_error", error_description: "try again" }, 500))
			const manager = new OpenAiCodexOAuthManager()

			const token = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				manager.getAccessToken(),
			)

			should(token).be.null()
			// Credentials preserved because the error is not an invalid grant
			stateManager.getSecretKey("openai-codex-oauth-credentials")?.should.be.a.String()
		})

		it("de-duplicates concurrent refresh requests", async () => {
			stateManager.setSecret(
				"openai-codex-oauth-credentials",
				validCredentials({ refresh_token: "rt", expires: Date.now() - 1000 }),
			)
			const newToken = createJwt({ chatgpt_account_id: "account-123" })
			const fetchStub = sinon
				.stub()
				.resolves(jsonResponse({ access_token: newToken, refresh_token: "new-rt", expires_in: 3600 }))
			const manager = new OpenAiCodexOAuthManager()

			await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, async () => {
				const [a, b] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()])
				should(a).equal(newToken)
				should(b).equal(newToken)
			})

			sinon.assert.calledOnce(fetchStub)
		})
	})

	describe("forceRefreshAccessToken", () => {
		it("returns null when no credentials are stored", async () => {
			const manager = new OpenAiCodexOAuthManager()
			should(await manager.forceRefreshAccessToken()).be.null()
		})

		it("forces a refresh even when the token is not expired", async () => {
			stateManager.setSecret("openai-codex-oauth-credentials", validCredentials({ access_token: "still-valid" }))
			const newToken = createJwt({ chatgpt_account_id: "account-123" })
			const fetchStub = sinon
				.stub()
				.resolves(jsonResponse({ access_token: newToken, refresh_token: "new-rt", expires_in: 3600 }))
			const manager = new OpenAiCodexOAuthManager()

			const token = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				manager.forceRefreshAccessToken(),
			)

			should(token).equal(newToken)
			sinon.assert.calledOnce(fetchStub)
		})
	})
})

describe("OpenAiCodexOAuthManager authorization code flow", () => {
	let stateManager: TestStateManager

	beforeEach(() => {
		stateManager = new TestStateManager()
		sinon.stub(StateManager, "get").returns(stateManager as unknown as StateManager)
	})

	afterEach(() => {
		sinon.restore()
	})

	describe("PKCE helpers", () => {
		it("generateCodeVerifier produces a unique base64url string of the expected length", () => {
			const a = generateCodeVerifier()
			const b = generateCodeVerifier()
			a.should.not.equal(b)
			a.length.should.be.greaterThanOrEqual(43)
			const base64url = /^[A-Za-z0-9_-]+$/
			base64url.test(a).should.be.true()
		})

		it("generateCodeChallenge derives a deterministic S256 challenge from a verifier", () => {
			const verifier = "verifier-123"
			const challenge = generateCodeChallenge(verifier)
			challenge.should.equal(generateCodeChallenge(verifier))
			challenge.should.not.equal(verifier)
		})

		it("generateState produces a unique hex string", () => {
			generateState().should.not.equal(generateState())
			const hex = /^[0-9a-f]+$/
			hex.test(generateState()).should.be.true()
		})

		it("buildAuthorizationUrl encodes codex-specific params and PKCE challenge", () => {
			const url = buildAuthorizationUrl("challenge-abc", "state-xyz")
			url.should.startWith(OPENAI_CODEX_OAUTH_CONFIG.authorizationEndpoint)
			const params = new URL(url).searchParams
			params.get("client_id")?.should.equal(OPENAI_CODEX_OAUTH_CONFIG.clientId)
			params.get("code_challenge")?.should.equal("challenge-abc")
			params.get("code_challenge_method")?.should.equal("S256")
			params.get("state")?.should.equal("state-xyz")
			params.get("codex_cli_simplified_flow")?.should.equal("true")
			params.get("originator")?.should.equal("dirac")
		})
	})

	describe("isTokenExpired", () => {
		it("treats tokens expiring within the 5-minute buffer as expired", () => {
			isTokenExpired({
				type: "openai-codex",
				access_token: "a",
				refresh_token: "r",
				expires: Date.now() + 60000,
			}).should.be.true()
		})

		it("treats tokens expiring well in the future as valid", () => {
			isTokenExpired({
				type: "openai-codex",
				access_token: "a",
				refresh_token: "r",
				expires: Date.now() + 3600000,
			}).should.be.false()
		})
	})

	describe("exchangeCodeForTokens", () => {
		it("exchanges an authorization code for credentials using form-urlencoded", async () => {
			const accessToken = createJwt({ chatgpt_account_id: "acc-1" })
			const fetchStub = sinon.stub().resolves(
				jsonResponse({
					access_token: accessToken,
					refresh_token: "rt",
					expires_in: 3600,
					email: "u@example.com",
				}),
			)

			const creds = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				exchangeCodeForTokens("code-1", "verifier-1"),
			)

			creds.type.should.equal("openai-codex")
			creds.access_token!.should.equal(accessToken)
			creds.accountId?.should.equal("acc-1")
			creds.refresh_token!.should.equal("rt")

			const [url, init] = fetchStub.firstCall.args as [string, RequestInit]
			url.should.equal(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint)
				; (init.headers as Record<string, string>)["Content-Type"].should.equal("application/x-www-form-urlencoded")
			const body = new URLSearchParams(init.body as string)
			body.get("grant_type")?.should.equal("authorization_code")
			body.get("code")?.should.equal("code-1")
			body.get("code_verifier")?.should.equal("verifier-1")
			body.get("redirect_uri")?.should.equal(OPENAI_CODEX_OAUTH_CONFIG.redirectUri)
		})

		it("throws when the token exchange response omits a refresh_token", async () => {
			const fetchStub = sinon.stub().resolves(jsonResponse({ access_token: "a", expires_in: 3600 }))
			await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				exchangeCodeForTokens("code-1", "verifier-1"),
			).should.be.rejectedWith("Token exchange did not return a refresh_token")
		})

		it("throws a descriptive error on a non-OK response", async () => {
			const fetchStub = sinon.stub().resolves(new Response("bad request", { status: 400, statusText: "Bad Request" }))
			await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				exchangeCodeForTokens("code-1", "verifier-1"),
			).should.be.rejectedWith(/Token exchange failed: 400/)
		})
	})

	describe("refreshAccessToken (free function)", () => {
		it("preserves the existing refresh_token when the response omits one", async () => {
			const fetchStub = sinon.stub().resolves(jsonResponse({ access_token: "new-a", expires_in: 3600 }))
			const creds = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				refreshAccessToken({
					type: "openai-codex",
					access_token: "old-a",
					refresh_token: "kept-rt",
					expires: 0,
					email: "u@example.com",
					accountId: "acc",
				}),
			)
			creds.refresh_token!.should.equal("kept-rt")
			creds.email!.should.equal("u@example.com")
			creds.accountId!.should.equal("acc")
		})

		it("throws OpenAiCodexOAuthTokenError-like message on a 400 invalid_grant", async () => {
			expectLoggerErrors()
			const fetchStub = sinon.stub().resolves(jsonResponse({ error: "invalid_grant", error_description: "revoked" }, 400))
			await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
				refreshAccessToken({ type: "openai-codex", access_token: "a", refresh_token: "r", expires: 0 }),
			).should.be.rejectedWith(/Token refresh failed: 400/)
		})
	})

	describe("startAuthorizationFlow / cancelAuthorizationFlow", () => {
		it("returns an authorization URL and tracks pending state", () => {
			const manager = new OpenAiCodexOAuthManager()
			const url = manager.startAuthorizationFlow()
			url.should.startWith(OPENAI_CODEX_OAUTH_CONFIG.authorizationEndpoint)
			manager.cancelAuthorizationFlow()
		})

		it("cancelAuthorizationFlow is safe to call with no pending flow", () => {
			const manager = new OpenAiCodexOAuthManager()
			manager.cancelAuthorizationFlow()
		})

		it("waitForCallback rejects when no flow was started", async () => {
			const manager = new OpenAiCodexOAuthManager()
			await manager.waitForCallback().should.be.rejectedWith("No pending authorization flow")
		})
	})
})
