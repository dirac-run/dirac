import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import lockfile from "proper-lockfile"
import sinon from "sinon"
import { fetch, mockFetchForTesting } from "@/shared/net"
import { QwenSubscriptionSession } from "../qwen-subscription-session"

const freshTokens = () => ({
	access_token: "new-access-secret",
	refresh_token: "new-refresh-secret",
	token_type: "Bearer",
	scope: "model:invoke profile:read",
	expires_in: 3600,
})
const credentials = (expiresAt = Date.now() + 3600_000) => ({
	revision: "same-login-revision",
	signInAttempt: "pending-sign-in",
	baseUrl: "https://auth.qwen.ai",
	clientId: "qwen-code-cli",
	models: ["qwen-test-model"],
	modelMetadata: [{ id: "qwen-test-model", contextWindowSize: 32000 }],
	futureMetadata: { keep: true },
	tokens: {
		...freshTokens(),
		access_token: "old-access-secret",
		refresh_token: "old-refresh-secret",
		expiresAt,
		futureTokenMetadata: "keep",
	},
	retryAfter: { userinfo: 123 },
})
const jsonResponse = (data: unknown = freshTokens(), status = 200, headers?: Record<string, string>) =>
	new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } })

// Every test uses synthetic credentials in an isolated directory and a fake fetch.
describe("QwenSubscriptionSession", () => {
	let directory: string
	let filePath: string
	let fetchStub: sinon.SinonStub
	const write = (data: unknown) => fs.writeFile(filePath, JSON.stringify(data))
	const read = async () => JSON.parse(await fs.readFile(filePath, "utf8"))
	const session = () => new QwenSubscriptionSession(filePath, fetch)
	const withFetch = <T>(run: () => Promise<T>) => mockFetchForTesting(fetchStub as typeof fetch, run)

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-qwen-session-test-"))
		filePath = path.join(directory, "subscription_credentials.json")
		fetchStub = sinon.stub().callsFake(async () => jsonResponse())
		await write(credentials())
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("re-reads disk on every request and observes replacement logins", async () => {
		await withFetch(async () => {
			const shared = session()
			assert.equal(await shared.accessToken(), "old-access-secret")
			const replacement = credentials()
			replacement.revision = "another-login"
			replacement.tokens.access_token = "replacement-access"
			await write(replacement)
			assert.equal(await shared.accessToken(), "replacement-access")
			await fs.rm(filePath)
			await assert.rejects(shared.accessToken(), /not found.*Sign in/)
		})
		assert.equal(fetchStub.callCount, 0)
	})

	it("refreshes within the 30-second margin with the fixed origin/client and no redirects", async () => {
		const previous = credentials(Date.now() + 29_000)
		await write(previous)
		await withFetch(async () => assert.equal(await session().accessToken(), "new-access-secret"))
		assert.equal(fetchStub.callCount, 1)
		const [url, options] = fetchStub.firstCall.args
		assert.equal(url, "https://auth.qwen.ai/api/oauth/token")
		assert.equal(options.method, "POST")
		assert.equal(options.redirect, "error")
		assert.ok(options.signal instanceof AbortSignal)
		assert.equal(options.signal.aborted, false)
		assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
			grant_type: "refresh_token",
			client_id: "qwen-code-cli",
			refresh_token: "old-refresh-secret",
		})
		const current = await read()
		assert.equal(current.revision, previous.revision)
		assert.equal(current.signInAttempt, previous.signInAttempt)
		assert.deepEqual(current.models, previous.models)
		assert.deepEqual(current.modelMetadata, previous.modelMetadata)
		assert.deepEqual(current.futureMetadata, previous.futureMetadata)
		assert.deepEqual(current.retryAfter, previous.retryAfter)
		assert.equal(current.tokens.futureTokenMetadata, "keep")
		assert.equal(current.tokens.refresh_token, "new-refresh-secret")
		assert.ok(current.tokens.expiresAt > Date.now() + 3590_000)
		if (process.platform !== "win32") assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600)
		assert.deepEqual(await fs.readdir(directory), ["subscription_credentials.json"])
	})

	it("does not refresh a sufficiently fresh token", async () => {
		await withFetch(async () => assert.equal(await session().accessToken(), "old-access-secret"))
		assert.equal(fetchStub.callCount, 0)
	})

	it("refreshes a rejected current token even before expiry", async () => {
		await withFetch(async () => assert.equal(await session().accessToken("old-access-secret"), "new-access-secret"))
		assert.equal(fetchStub.callCount, 1)
	})

	it("reuses another process's replacement token for a delayed 401", async () => {
		await withFetch(async () => assert.equal(await session().accessToken("already-replaced-access"), "old-access-secret"))
		assert.equal(fetchStub.callCount, 0)
	})

	it("still refreshes an expiring replacement token after a delayed 401", async () => {
		await write(credentials(Date.now() - 1000))
		await withFetch(async () => assert.equal(await session().accessToken("already-replaced-access"), "new-access-secret"))
		assert.equal(fetchStub.callCount, 1)
	})

	it("serializes different instances and refreshes a rejected token only once", async () => {
		await withFetch(async () => {
			const tokens = await Promise.all(Array.from({ length: 8 }, () => session().accessToken("old-access-secret")))
			assert.deepEqual(tokens, Array(8).fill("new-access-secret"))
		})
		assert.equal(fetchStub.callCount, 1)
	})

	it("shares the official lock with another process and re-reads after acquiring it", async function () {
		this.timeout(10_000)
		await write(credentials(0))
		const child = spawn(
			process.execPath,
			[
				"-e",
				`
			require('proper-lockfile').lock(process.argv[1], {realpath:false, stale:60000, retries:0})
			.then(release => { process.stdout.write('locked'); process.stdin.once('data', async () => { await release(); process.exit(0) }) })
			.catch(error => { console.error(error); process.exit(1) })
		`,
				filePath,
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		)
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.once("data", () => resolve())
				child.once("error", reject)
				child.once("exit", (code) => {
					if (code) reject(new Error(`Lock process exited: ${code}`))
				})
			})
			await withFetch(async () => {
				const pending = session().accessToken()
				await write(credentials())
				child.stdin.write("release")
				assert.equal(await pending, "old-access-secret")
			})
			assert.equal(fetchStub.callCount, 0)
		} finally {
			child.kill()
		}
	})

	it("shares Retry-After cooldown without deleting or rotating cached credentials", async () => {
		await write(credentials(0))
		fetchStub.callsFake(async () => jsonResponse({ error_description: "do-not-print-secret" }, 429, { "Retry-After": "60" }))
		await withFetch(async () => {
			await assert.rejects(session().accessToken(), /rate limited.*60 seconds/)
			await assert.rejects(session().accessToken(), /rate limited/)
		})
		assert.equal(fetchStub.callCount, 1)
		const current = await read()
		assert.equal(current.tokens.refresh_token, "old-refresh-secret")
		assert.equal(current.revision, "same-login-revision")
		assert.equal(current.retryAfter.userinfo, 123)
		assert.ok(current.retryAfter.refresh > Date.now() + 50_000)
	})

	it("resumes refresh after an expired shared cooldown", async () => {
		await write({ ...credentials(0), retryAfter: { refresh: Date.now() - 1000 } })
		await withFetch(async () => assert.equal(await session().accessToken(), "new-access-secret"))
		assert.equal(fetchStub.callCount, 1)
	})

	for (const status of [400, 401, 403, 500, 307]) {
		it(`sanitizes HTTP ${status} and never deletes credentials`, async () => {
			await write(credentials(0))
			const original = await fs.readFile(filePath, "utf8")
			fetchStub.callsFake(async () => jsonResponse({ error: "invalid_grant", error_description: "server-secret" }, status))
			await withFetch(async () => {
				await assert.rejects(session().accessToken(), (error: Error) => {
					assert.match(error.message, /Qwen Subscription/)
					assert.doesNotMatch(error.message, /server-secret|old-refresh-secret|old-access-secret/)
					assert.equal(error.cause, undefined)
					return true
				})
			})
			assert.equal(await fs.readFile(filePath, "utf8"), original)
		})
	}

	for (const status of [400, 403]) {
		it(`does not prescribe reauthentication for non-invalid_grant HTTP ${status}`, async () => {
			await write(credentials(0))
			const original = await fs.readFile(filePath, "utf8")
			fetchStub.callsFake(async () =>
				jsonResponse({ error: "subscription_denied", error_description: "server-secret" }, status),
			)
			await withFetch(async () => {
				await assert.rejects(session().accessToken(), (error: Error) => {
					assert.match(error.message, new RegExp(`HTTP ${status}`))
					assert.doesNotMatch(error.message, /Sign in|server-secret/)
					return true
				})
			})
			assert.equal(await fs.readFile(filePath, "utf8"), original)
		})
	}

	it("sanitizes transport failures", async () => {
		await write(credentials(0))
		fetchStub.rejects(new Error("old-refresh-secret: injected transport detail"))
		await withFetch(async () => {
			await assert.rejects(session().accessToken(), /Check your connection and retry/)
		})
		assert.equal((await read()).tokens.refresh_token, "old-refresh-secret")
	})

	for (const response of [
		{ ...freshTokens(), refresh_token: "" },
		{ ...freshTokens(), token_type: "basic" },
		{ ...freshTokens(), expires_in: 0 },
		{ ...freshTokens(), expires_in: 1e308 },
	]) {
		it("rejects invalid refresh tokens without changing credentials", async () => {
			await write(credentials(0))
			const original = await fs.readFile(filePath, "utf8")
			fetchStub.callsFake(async () => jsonResponse(response))
			await withFetch(async () => assert.rejects(session().accessToken(), /invalid tokens/))
			assert.equal(await fs.readFile(filePath, "utf8"), original)
		})
	}

	it("bounds the refresh response size", async () => {
		await write(credentials(0))
		fetchStub.callsFake(async () => new Response("x".repeat(65 * 1024)))
		await withFetch(async () => assert.rejects(session().accessToken(), /invalid response/))
		assert.equal((await read()).tokens.refresh_token, "old-refresh-secret")
	})

	for (const change of [
		{ baseUrl: "https://attacker.invalid" },
		{ clientId: "attacker-client" },
		{ revision: "" },
		{ tokens: undefined },
		{ tokens: { ...credentials().tokens, expiresAt: "not-a-date" } },
	]) {
		it("rejects incompatible cached credentials before any network request", async () => {
			await write({ ...credentials(), ...change })
			await withFetch(async () => assert.rejects(session().accessToken(), /Invalid or incompatible/))
			assert.equal(fetchStub.callCount, 0)
		})
	}

	it("sanitizes malformed JSON and oversized cache files", async () => {
		await fs.writeFile(filePath, '{"secret":"unterminated')
		await withFetch(async () => assert.rejects(session().accessToken(), /Invalid Qwen Subscription/))
		await fs.writeFile(filePath, "x".repeat(1024 * 1024 + 1))
		await withFetch(async () => assert.rejects(session().accessToken(), /Invalid Qwen Subscription/))
		assert.equal(fetchStub.callCount, 0)
	})

	it("rejects symlink credentials without reading or overwriting the target", async function () {
		if (process.platform === "win32") this.skip()
		const target = path.join(directory, "target.json")
		await fs.rename(filePath, target)
		await fs.symlink(target, filePath)
		const original = await fs.readFile(target, "utf8")
		await withFetch(async () => assert.rejects(session().accessToken(), /symbolic link/))
		assert.equal(fetchStub.callCount, 0)
		assert.equal(await fs.readFile(target, "utf8"), original)
		assert.ok((await fs.lstat(filePath)).isSymbolicLink())
	})

	it("rejects non-regular credential files", async () => {
		await fs.rm(filePath)
		await fs.mkdir(filePath)
		await withFetch(async () => assert.rejects(session().accessToken(), /regular file/))
		assert.equal(fetchStub.callCount, 0)
	})

	it("does not overwrite a newer sign-in installed during refresh", async () => {
		await write(credentials(0))
		const replacement = { ...credentials(), revision: "new-sign-in" }
		fetchStub.callsFake(async () => {
			await write(replacement)
			return jsonResponse()
		})
		await withFetch(async () => assert.rejects(session().accessToken(), /session changed/))
		assert.deepEqual(await read(), replacement)
		assert.deepEqual(await fs.readdir(directory), ["subscription_credentials.json"])
	})

	it("does not resurrect credentials removed during refresh", async () => {
		await write(credentials(0))
		fetchStub.callsFake(async () => {
			await fs.rm(filePath)
			return jsonResponse()
		})
		await withFetch(async () => assert.rejects(session().accessToken(), /not found/))
		await assert.rejects(fs.stat(filePath), { code: "ENOENT" })
		assert.deepEqual(await fs.readdir(directory), [])
	})

	it("does not commit after lock compromise", async () => {
		await write(credentials(0))
		let compromise: () => void = () => {
			throw new Error("Missing compromise callback")
		}
		sinon.stub(lockfile, "lock").callsFake(async (_file, options) => {
			compromise = (options as typeof options & { onCompromised: () => void }).onCompromised
			return () => Promise.resolve()
		})
		fetchStub.callsFake(async () => {
			compromise()
			return jsonResponse()
		})
		await withFetch(async () => assert.rejects(session().accessToken(), /lock changed/))
		assert.equal((await read()).tokens.refresh_token, "old-refresh-secret")
	})
})
