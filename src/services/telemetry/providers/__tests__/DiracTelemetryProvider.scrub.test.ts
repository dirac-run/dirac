import * as assert from "assert"
import { diracTelemetryConfig } from "@/shared/services/config/dirac-telemetry-config"
import { mockFetchForTesting } from "@/shared/net"
import { DiracTelemetryProvider, isSensitiveKey, scrubTelemetryProperties } from "../DiracTelemetryProvider"

describe("DiracTelemetryProvider secret scrubbing (FB-39)", () => {
	describe("isSensitiveKey", () => {
		it("recognizes standard sensitive key variations", () => {
			const sensitiveKeys = [
				"apiKey",
				"api_key",
				"API_KEY",
				"api-key",
				"apikey",
				"password",
				"Password",
				"PASSWORD",
				"passwd",
				"secret",
				"clientSecret",
				"client_secret",
				"token",
				"accessToken",
				"access_token",
				"refreshToken",
				"refresh_token",
				"authToken",
				"auth_token",
				"idToken",
				"authorization",
				"Authorization",
				"credential",
				"credentials",
				"privateKey",
				"private_key",
				"cookie",
				"cookies",
			]

			for (const key of sensitiveKeys) {
				assert.strictEqual(isSensitiveKey(key), true, `Expected '${key}' to be recognized as sensitive`)
			}
		})

		it("does not flag common non-sensitive keys", () => {
			const nonSensitiveKeys = [
				"username",
				"email",
				"name",
				"author",
				"id",
				"status",
				"version",
				"path",
				"message",
				"query",
				"modelId",
				"toolName",
				"duration",
			]

			for (const key of nonSensitiveKeys) {
				assert.strictEqual(isSensitiveKey(key), false, `Expected '${key}' not to be sensitive`)
			}
		})
	})

	describe("scrubTelemetryProperties - Object Key Redaction", () => {
		it("redacts recognized sensitive keys directly regardless of value format", () => {
			const properties = {
				password: "myPlainTextPassword123",
				apiKey: "simple-api-key-value",
				secret: "raw-secret-token",
				token: "plain_token_string",
				authorization: "Basic dXNlcjpwYXNz",
				safeField: "safe value",
			}

			const scrubbed = scrubTelemetryProperties(properties) as typeof properties

			assert.strictEqual(scrubbed.password, "[REDACTED]")
			assert.strictEqual(scrubbed.apiKey, "[REDACTED]")
			assert.strictEqual(scrubbed.secret, "[REDACTED]")
			assert.strictEqual(scrubbed.token, "[REDACTED]")
			assert.strictEqual(scrubbed.authorization, "[REDACTED]")
			assert.strictEqual(scrubbed.safeField, "safe value")
		})

		it("redacts sensitive keys in deeply nested objects", () => {
			const properties = {
				service: "database",
				config: {
					host: "db.internal.net",
					port: 5432,
					credentials: {
						user: "admin",
						password: "dbPasswordSuperSecret",
						clientSecret: "oauth_client_secret_xyz",
					},
				},
				metadata: {
					auth: {
						token: "session_token_12345",
					},
				},
			}

			const scrubbed = scrubTelemetryProperties(properties) as any

			assert.strictEqual(scrubbed.service, "database")
			assert.strictEqual(scrubbed.config.host, "db.internal.net")
			assert.strictEqual(scrubbed.config.port, 5432)
			assert.strictEqual(scrubbed.config.credentials.user, "admin")
			assert.strictEqual(scrubbed.config.credentials.password, "[REDACTED]")
			assert.strictEqual(scrubbed.config.credentials.clientSecret, "[REDACTED]")
			assert.strictEqual(scrubbed.metadata.auth.token, "[REDACTED]")
		})

		it("redacts sensitive keys inside arrays and nested array structures", () => {
			const properties = {
				accounts: [
					{ username: "alice", apiKey: "key-alice-123" },
					{ username: "bob", password: "bob-password-456" },
				],
				tokens: ["tokenA", "tokenB"],
				matrix: [
					[
						{ id: 1, secret: "matrix_secret_1" },
						{ id: 2, safe: "matrix_safe_2" },
					],
				],
			}

			const scrubbed = scrubTelemetryProperties(properties) as any

			assert.strictEqual(scrubbed.accounts[0].username, "alice")
			assert.strictEqual(scrubbed.accounts[0].apiKey, "[REDACTED]")
			assert.strictEqual(scrubbed.accounts[1].username, "bob")
			assert.strictEqual(scrubbed.accounts[1].password, "[REDACTED]")
			assert.strictEqual(scrubbed.matrix[0][0].secret, "[REDACTED]")
			assert.strictEqual(scrubbed.matrix[0][1].safe, "matrix_safe_2")
		})
	})

	describe("scrubTelemetryProperties - Pattern Redaction & Truncation", () => {
		it("redacts Bearer tokens while preserving the prefix", () => {
			const result = scrubTelemetryProperties("Authorization: Bearer secret_token_value_abc")
			assert.strictEqual(result, "Authorization: Bearer [REDACTED]")
		})

		it("redacts OpenAI-style sk- keys", () => {
			const result = scrubTelemetryProperties("Error with key sk-1234567890abcdefghijklmnop in config")
			assert.strictEqual(result, "Error with key [REDACTED] in config")
		})

		it("redacts GitHub PATs (ghp_)", () => {
			const result = scrubTelemetryProperties("git clone https://ghp_12345678901234567890@github.com/repo")
			assert.strictEqual(result, "git clone https://[REDACTED]@github.com/repo")
		})

		it("redacts Slack tokens (xox*)", () => {
			const result = scrubTelemetryProperties("Connected slack token xoxb-1234567890-abcdef1234")
			assert.strictEqual(result, "Connected slack token [REDACTED]")
		})

		it("redacts AWS access key IDs (AKIA...)", () => {
			const result = scrubTelemetryProperties("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")
			assert.strictEqual(result, "AWS_ACCESS_KEY_ID=[REDACTED]")
		})

		it("redacts key=value secret patterns", () => {
			const result = scrubTelemetryProperties("db connection api_key=secretKey123 and token: myToken456")
			assert.strictEqual(result, "db connection api_key=[REDACTED] and token: [REDACTED]")
		})

		it("truncates strings exceeding 2000 characters with ellipsis", () => {
			const longString = "A".repeat(2500)
			const scrubbed = scrubTelemetryProperties(longString) as string

			assert.strictEqual(scrubbed.length, 2000 + "…[truncated]".length)
			assert.strictEqual(scrubbed.endsWith("…[truncated]"), true)
			assert.strictEqual(scrubbed.startsWith("A".repeat(2000)), true)
		})

		it("leaves strings <= 2000 characters intact if no secrets present", () => {
			const normalString = "Hello world, this is a clean log message."
			const scrubbed = scrubTelemetryProperties(normalString)
			assert.strictEqual(scrubbed, normalString)
		})
	})

	describe("captureToDirac Integration", () => {
		let originalHost: string
		let originalApiKey: string | undefined

		beforeEach(() => {
			originalHost = diracTelemetryConfig.host
			originalApiKey = diracTelemetryConfig.apiKey
			diracTelemetryConfig.host = "https://telemetry.dirac.run/events"
			diracTelemetryConfig.apiKey = "test-api-key"
		})

		afterEach(() => {
			diracTelemetryConfig.host = originalHost
			diracTelemetryConfig.apiKey = originalApiKey
		})

		it("scrubs sensitive keys and secret patterns in posted payload", async () => {
			let capturedBody: any = null

			const mockFetch = (async (_url: any, options?: RequestInit) => {
				capturedBody = JSON.parse(options?.body as string)
				return new Response(JSON.stringify({ status: "ok" }), { status: 200 })
			}) as unknown as typeof globalThis.fetch

			await mockFetchForTesting(mockFetch, async () => {
				const provider = new DiracTelemetryProvider()
				// Force provider settings to enabled
				provider.getSettings().hostEnabled = true
				provider.getSettings().level = "all"

				provider.logRequired("test_event", {
					password: "rawUserPassword",
					apiKey: "rawApiKey",
					command: "curl -H 'Authorization: Bearer mySecretToken' https://api.com",
					nested: {
						secret: "deepSecretValue",
						safeData: "regularInfo",
					},
					items: [{ token: "arrayTokenValue", name: "item1" }],
				})

				// Allow async fetch to complete
				await new Promise((resolve) => setTimeout(resolve, 50))
			})

			assert.notStrictEqual(capturedBody, null)
			assert.strictEqual(capturedBody.event, "test_event")
			assert.strictEqual(capturedBody.properties.password, "[REDACTED]")
			assert.strictEqual(capturedBody.properties.apiKey, "[REDACTED]")
			assert.strictEqual(capturedBody.properties.command, "curl -H 'Authorization: Bearer [REDACTED]' https://api.com")
			assert.strictEqual(capturedBody.properties.nested.secret, "[REDACTED]")
			assert.strictEqual(capturedBody.properties.nested.safeData, "regularInfo")
			assert.strictEqual(capturedBody.properties.items[0].token, "[REDACTED]")
			assert.strictEqual(capturedBody.properties.items[0].name, "item1")
		})
	})
})
