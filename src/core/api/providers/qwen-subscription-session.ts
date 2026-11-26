import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { lock } from "proper-lockfile"
import { z } from "zod"

// Protocol and cache format confirmed against QwenLM/qwen-code's
// packages/core/src/qwen/{subscription-session,subscription-oauth-client,oauth-config}.ts.
const OAUTH_ORIGIN = "https://auth.qwen.ai"
const CLIENT_ID = "qwen-code-cli"
const MAX_CREDENTIAL_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const SIGN_IN = "Sign in with Qwen Code (/auth), then retry."

const tokenSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	token_type: z.literal("Bearer"),
	scope: z.string(),
	expires_in: z.number().positive().finite(),
})
const credentialSchema = z
	.object({
		revision: z.string().min(1),
		baseUrl: z.literal(OAUTH_ORIGIN),
		clientId: z.literal(CLIENT_ID),
		tokens: tokenSchema.extend({ expiresAt: z.number().finite() }).passthrough(),
		retryAfter: z.object({ refresh: z.number().finite().optional() }).passthrough().optional(),
	})
	.passthrough()
type Credentials = z.infer<typeof credentialSchema>
type Snapshot = { credentials: Credentials; source: string; dev: number; ino: number }

// Only errors constructed here may cross the session boundary. Never expose server
// bodies, filesystem paths, Zod input, fetch errors, or Error.cause containing secrets.
class SessionError extends Error {
	constructor(
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message)
	}
}

function credentialsError(error: unknown): SessionError {
	if (error instanceof SessionError) return error
	const code = (error as NodeJS.ErrnoException)?.code
	if (code === "ENOENT") return new SessionError(`Qwen Subscription credentials were not found. ${SIGN_IN}`)
	if (code === "EACCES" || code === "EPERM")
		return new SessionError("Cannot access Qwen Subscription credentials. Check credential directory permissions and retry.")
	if (code === "ELOOP") return new SessionError("Qwen Subscription credentials must be a regular file, not a symbolic link.")
	return new SessionError("Cannot safely read or update Qwen Subscription credentials. Check the credential file and retry.")
}

async function readCredentials(filePath: string): Promise<Snapshot> {
	const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = await file.stat()
		if (!stat.isFile()) throw new SessionError("Qwen Subscription credentials must be a regular file.")
		if (stat.size > MAX_CREDENTIAL_BYTES) throw new SessionError(`Invalid Qwen Subscription credentials. ${SIGN_IN}`)
		const bytes = Buffer.alloc(stat.size + 1)
		let length = 0
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
			if (!bytesRead) break
			length += bytesRead
		}
		if (length === bytes.length)
			throw new SessionError("Qwen Subscription credentials changed while reading. Retry the request.")
		const source = bytes.toString("utf8", 0, length)
		let data: unknown
		try {
			data = JSON.parse(source)
		} catch {
			throw new SessionError(`Invalid Qwen Subscription credentials. ${SIGN_IN}`)
		}
		const parsed = credentialSchema.safeParse(data)
		if (!parsed.success) throw new SessionError(`Invalid or incompatible Qwen Subscription credentials. ${SIGN_IN}`)
		return { credentials: parsed.data, source, dev: stat.dev, ino: stat.ino }
	} finally {
		await file.close()
	}
}

async function responseJson(response: Response): Promise<unknown> {
	if (!response.body) throw new SessionError("Qwen Subscription refresh returned an invalid response. Retry later.")
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) break
			length += value.length
			if (length > MAX_RESPONSE_BYTES) {
				await reader.cancel()
				throw new SessionError("Qwen Subscription refresh returned an invalid response. Retry later.")
			}
			chunks.push(value)
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"))
	} catch (error) {
		if (error instanceof SessionError) throw error
		throw new SessionError("Qwen Subscription refresh returned an unreadable response. Check your connection and retry.")
	} finally {
		reader.releaseLock()
	}
}

function retryAfter(value: string | null): number | undefined {
	if (!value?.trim()) return undefined
	const seconds = Number(value)
	const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
	return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined
}

async function requestTokens(refreshToken: string, request: typeof globalThis.fetch): Promise<z.infer<typeof tokenSchema>> {
	let response: Response
	try {
		response = await request(`${OAUTH_ORIGIN}/api/oauth/token`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			}).toString(),
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		})
	} catch {
		throw new SessionError(
			"Qwen Subscription refresh could not reach the trusted authentication service. Check your connection and retry.",
		)
	}
	if (response.status === 429) {
		const wait = retryAfter(response.headers.get("Retry-After")) ?? 30_000
		await response.body?.cancel()
		throw new SessionError(`Qwen Subscription refresh is rate limited. Retry in ${Math.ceil(wait / 1000)} seconds.`, wait)
	}
	const data = await responseJson(response)
	if (!response.ok) {
		const failure = z.object({ error: z.string() }).safeParse(data)
		if (failure.success && failure.data.error === "invalid_grant")
			throw new SessionError(`Qwen Subscription session could not be refreshed. ${SIGN_IN}`)
		throw new SessionError(`Qwen Subscription refresh failed (HTTP ${response.status}). Retry later.`)
	}
	const parsed = tokenSchema.safeParse(data)
	if (!parsed.success || !Number.isFinite(Date.now() + parsed.data.expires_in * 1000))
		throw new SessionError("Qwen Subscription refresh returned invalid tokens. Retry later.")
	return parsed.data
}

async function releaseCredentialLock(release: () => Promise<void>): Promise<void> {
	try {
		await release()
	} catch (error) {
		// A compromised lock is already released by proper-lockfile itself.
		if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error
	}
}

/** Shares Qwen Code's subscription credentials and cross-process refresh lock. */
export class QwenSubscriptionSession {
	constructor(
		private readonly filePath: string,
		private readonly request: typeof globalThis.fetch,
	) {
		// The provider supplies shared/net fetch without coupling this session to the provider graph.
	}

	async accessToken(rejectedToken?: string): Promise<string> {
		try {
			// Canonicalize the parent, not the credential itself: aliases share a lock,
			// while a credential symlink is still rejected by O_NOFOLLOW.
			const filePath = path.join(await fs.realpath(path.dirname(this.filePath)), path.basename(this.filePath))
			let compromised = false
			const options = {
				realpath: false,
				stale: 60_000,
				retries: 0,
				onCompromised: () => {
					compromised = true
				},
			}
			let release: () => Promise<void>
			for (let attempt = 0; ; attempt++) {
				try {
					release = await lock(filePath, options)
					break
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error
					if (attempt >= 350)
						throw new SessionError(
							"Qwen Subscription credentials are busy. Wait for Qwen Code to finish signing in and retry.",
						)
					await delay(100)
				}
			}
			const assertCanCommit = () => {
				if (compromised) throw new SessionError("Qwen Subscription credential lock changed. Retry the request.")
			}
			try {
				assertCanCommit()
				const snapshot = await readCredentials(filePath)
				const { tokens } = snapshot.credentials
				// A newer token installed by another process wins a delayed 401, but
				// still needs refresh if it is itself approaching expiry.
				if (tokens.expiresAt <= Date.now() + 30_000 || tokens.access_token === rejectedToken)
					await this.refresh(filePath, snapshot, assertCanCommit)
				assertCanCommit()
				return snapshot.credentials.tokens.access_token
			} finally {
				await releaseCredentialLock(release)
			}
		} catch (error) {
			throw credentialsError(error)
		}
	}

	private async refresh(filePath: string, snapshot: Snapshot, assertCanCommit: () => void): Promise<void> {
		const { credentials } = snapshot
		const remaining = (credentials.retryAfter?.refresh ?? 0) - Date.now()
		if (remaining > 0)
			throw new SessionError(`Qwen Subscription refresh is rate limited. Retry in ${Math.ceil(remaining / 1000)} seconds.`)
		let tokens: z.infer<typeof tokenSchema>
		try {
			tokens = await requestTokens(credentials.tokens.refresh_token, this.request)
		} catch (error) {
			if (error instanceof SessionError && error.retryAfterMs) {
				credentials.retryAfter = { ...credentials.retryAfter, refresh: Date.now() + error.retryAfterMs }
				await this.commit(filePath, snapshot, assertCanCommit)
			}
			throw error
		}
		credentials.tokens = { ...credentials.tokens, ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 }
		await this.commit(filePath, snapshot, assertCanCommit)
	}

	private async commit(filePath: string, snapshot: Snapshot, assertCanCommit: () => void): Promise<void> {
		const temporaryPath = `${filePath}.${randomUUID()}.tmp`
		const temporary = await fs.open(
			temporaryPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		)
		try {
			try {
				await temporary.chmod(0o600)
				await temporary.writeFile(JSON.stringify(snapshot.credentials))
				await temporary.sync()
			} finally {
				await temporary.close()
			}
			// Cooperative writers use the shared lock. Also reject any changes by
			// non-cooperating writers observed immediately before the rename.
			const current = await readCredentials(filePath)
			if (current.source !== snapshot.source || current.dev !== snapshot.dev || current.ino !== snapshot.ino)
				throw new SessionError("Qwen Subscription session changed during refresh. Retry the request.")
			assertCanCommit()
			await fs.rename(temporaryPath, filePath)
		} finally {
			// Never remove credentials, including on invalid_grant; only our temp file.
			await fs.rm(temporaryPath, { force: true })
		}
	}
}
