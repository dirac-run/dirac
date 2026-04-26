import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import { StateManager } from "@/core/storage/StateManager"
import { mockFetchForTesting } from "@/shared/net"
import { OPENAI_CODEX_OAUTH_CONFIG, OpenAiCodexOAuthManager } from "../oauth"

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

	async flushPendingState(): Promise<void> {}
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

describe("OpenAiCodexOAuthManager device auth", () => {
	let stateManager: TestStateManager

	beforeEach(() => {
		stateManager = new TestStateManager()
		sinon.stub(StateManager, "get").returns(stateManager as unknown as StateManager)
	})

	afterEach(() => {
		sinon.restore()
	})

	it("initiates the Codex device flow with the OpenAI Codex client ID", async () => {
		const manager = new OpenAiCodexOAuthManager()
		const fetchStub = sinon.stub().resolves(
			jsonResponse({
				device_auth_id: "device-123",
				user_code: "ABCD-EFGH",
				interval: "5",
			}),
		)

		const result = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () => manager.initiateDeviceFlow())

		result.device_code.should.equal("device-123")
		result.user_code.should.equal("ABCD-EFGH")
		result.verification_uri.should.equal("https://auth.openai.com/codex/device")
		result.interval!.should.equal(5)

		sinon.assert.calledOnce(fetchStub)
		const [url, init] = fetchStub.firstCall.args as [string, RequestInit]
		url.should.equal(OPENAI_CODEX_OAUTH_CONFIG.deviceAuthorizationEndpoint)
		init.method!.should.equal("POST")
		;(init.headers as Record<string, string>)["Content-Type"].should.equal("application/json")

		const body = JSON.parse(init.body as string)
		body.client_id.should.equal(OPENAI_CODEX_OAUTH_CONFIG.clientId)
	})

	it("polls for an authorization code, exchanges it, and stores OpenAI Codex credentials", async () => {
		const manager = new OpenAiCodexOAuthManager()
		const accessToken = createJwt({ chatgpt_account_id: "account-123" })
		const fetchStub = sinon.stub()
		fetchStub.onFirstCall().resolves(
			jsonResponse({
				authorization_code: "auth-code-123",
				code_challenge: "challenge-123",
				code_verifier: "verifier-123",
			}),
		)
		fetchStub.onSecondCall().resolves(
			jsonResponse({
				access_token: accessToken,
				refresh_token: "refresh-123",
				expires_in: 3600,
				email: "user@example.com",
				token_type: "Bearer",
			}),
		)

		const credentials = await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
			manager.pollForDeviceToken("device-123", "ABCD-EFGH", 0),
		)

		credentials.type.should.equal("openai-codex")
		credentials.access_token.should.equal(accessToken)
		credentials.refresh_token.should.equal("refresh-123")
		credentials.email!.should.equal("user@example.com")
		credentials.accountId!.should.equal("account-123")
		credentials.expires.should.be.greaterThan(Date.now())

		const stored = JSON.parse(stateManager.getSecretKey("openai-codex-oauth-credentials")!)
		stored.access_token.should.equal(accessToken)
		stored.refresh_token.should.equal("refresh-123")
		stored.accountId.should.equal("account-123")

		const [pollUrl, pollInit] = fetchStub.firstCall.args as [string, RequestInit]
		pollUrl.should.equal(OPENAI_CODEX_OAUTH_CONFIG.deviceTokenEndpoint)
		const pollBody = JSON.parse(pollInit.body as string)
		pollBody.device_auth_id.should.equal("device-123")
		pollBody.user_code.should.equal("ABCD-EFGH")

		const [tokenUrl, tokenInit] = fetchStub.secondCall.args as [string, RequestInit]
		tokenUrl.should.equal(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint)
		const tokenBody = new URLSearchParams(tokenInit.body as string)
		tokenBody.get("grant_type")!.should.equal("authorization_code")
		tokenBody.get("code")!.should.equal("auth-code-123")
		tokenBody.get("redirect_uri")!.should.equal("https://auth.openai.com/deviceauth/callback")
		tokenBody.get("code_verifier")!.should.equal("verifier-123")
	})

	it("continues polling while authorization is pending", async () => {
		const manager = new OpenAiCodexOAuthManager()
		const fetchStub = sinon.stub()
		fetchStub.onFirstCall().resolves(jsonResponse({}, 403))
		fetchStub.onSecondCall().resolves(
			jsonResponse({
				authorization_code: "auth-code-123",
				code_challenge: "challenge-123",
				code_verifier: "verifier-123",
			}),
		)
		fetchStub.onThirdCall().resolves(
			jsonResponse({
				access_token: createJwt({ chatgpt_account_id: "account-123" }),
				refresh_token: "refresh-123",
				expires_in: 3600,
			}),
		)

		await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
			manager.pollForDeviceToken("device-123", "ABCD-EFGH", 0),
		)

		sinon.assert.calledThrice(fetchStub)
	})

	it("throws a clear error when the device code expires", async () => {
		const manager = new OpenAiCodexOAuthManager()
		const fetchStub = sinon.stub().callsFake(() => Promise.resolve(jsonResponse({}, 403)))
		const clock = sinon.useFakeTimers()

		const result = mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, () =>
			manager.pollForDeviceToken("device-123", "ABCD-EFGH", 60),
		)
		await clock.tickAsync(15 * 60 * 1000)

		await result.should.be.rejectedWith("The device code has expired. Please try again.")
	})

	it("explains that device auth may need to be enabled when the server rejects device auth", async () => {
		const manager = new OpenAiCodexOAuthManager()
		const fetchStub = sinon.stub().resolves(jsonResponse({}, 404))

		await mockFetchForTesting(fetchStub as unknown as typeof globalThis.fetch, async () => {
			await manager.initiateDeviceFlow().should.be.rejectedWith(
				"Device code authentication is not available. Enable device-code login in ChatGPT settings or use browser sign-in.",
			)
		})
	})
})
